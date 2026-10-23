import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import type { Ask } from "../hyperfide-asks/bridge-projection.js";
import {
  createAskNotifications,
  type AskNotificationState,
} from "./ask-notifications.js";
import { createPushNotificationsPlugin } from "./server.js";
import type { ExpoPushMessage } from "./sender.js";

const ask = (id: string, kind = "custom-blocking"): Ask => ({
  id,
  kind,
  repository: "/fixture",
  task: "3.4",
  question: "Continue?",
  status: "open",
  deadline: 12345,
});

describe("Ask notifications through the fake plugin host", () => {
  it("handles concurrent RPC failures when a later RPC throws synchronously and retries", async () => {
    let ready = false;
    const write = vi.fn(async (_state: AskNotificationState) => {});
    const notifications = createAskNotifications({
      bridge: {
        list: async () => {
          if (!ready) throw new Error("SDK unavailable");
          return { asks: [] };
        },
        policy: () => {
          if (!ready) throw new Error("SDK unavailable");
          return Promise.resolve({});
        },
      },
      read: async () => null,
      write,
      digestMinutes: async () => 0,
      send: async () => {},
    });
    await expect(notifications.refresh()).rejects.toThrow("SDK unavailable");
    ready = true;
    await notifications.refresh();
    expect(write).toHaveBeenCalledOnce();
  });

  it("uses policy RPC, sends one push per Ask and dedupes across plugin reloads", async () => {
    const asks = [
      ask("1"),
      ask("2", "custom-flagged"),
      ask("3", "custom-flagged"),
    ];
    let now = 100;
    const messages: ExpoPushMessage[][] = [];
    const rpc = vi.fn(async ({ method }: { method: string }) => {
      if (method === "list") return { asks };
      if (method === "policy")
        return {
          "custom-blocking": "block",
          "custom-flagged": "proceed-and-flag",
        };
      throw new Error(method);
    });
    const factory = createPushNotificationsPlugin({
      askPollMs: 5,
      now: () => now,
      fetch: async (_url, init) => {
        const batch = JSON.parse(init.body) as ExpoPushMessage[];
        messages.push(batch);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: batch.map(() => ({ status: "ok", id: "ticket" })),
            }),
        };
      },
    });
    let host = createFakePluginHost({
      pluginId: "hyperfide-push-notifications",
      settings: { askDigest: "5 minutes" },
      sdk: { plugins: { callRpc: rpc } },
    });
    await factory(host.hyperfide);
    await host.harness.callRpc("pushSubscriptions.add", {
      expoPushToken: "ExponentPushToken[fixture]",
      platform: "ios",
      deviceLabel: "fixture",
    });
    host.harness.runService("push-sender");
    const service = host.harness.runService("ask-notifications");
    try {
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]?.[0]?.body).toBe(
        "3.4 | custom-blocking | deadline: 12345",
      );
      expect(messages[0]?.[0]?.data.kind).toBe("ask");
      await vi.waitFor(() => expect(rpc.mock.calls.length).toBeGreaterThan(8));
      expect(messages).toHaveLength(1);
      now += 5 * 60_000;
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages[1]?.[0]?.title).toBe("2 flagged Asks");
      expect(messages[1]?.[0]?.body.split("\n")).toHaveLength(2);
      service.controller.abort();
      await service.done;
      host = await host.harness.lifecycle.reload(factory);
      host.harness.runService("push-sender");
      host.harness.runService("ask-notifications");
      const callsBefore = rpc.mock.calls.length;
      await vi.waitFor(() =>
        expect(rpc.mock.calls.length).toBeGreaterThan(callsBefore + 8),
      );
      expect(messages).toHaveLength(2);
      asks.push({ ...ask("1"), repository: "/other-repository" });
      await vi.waitFor(() => expect(messages).toHaveLength(3));
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("persists a pending digest, honors Off, drops answered Asks and retries failed sends", async () => {
    let state: AskNotificationState | null = null;
    let now = 0;
    let minutes = 0;
    const asks = [ask("1", "flag"), ask("2", "flag")];
    const send = vi.fn(async () => {});
    const args = {
      bridge: {
        list: async () => ({ asks }),
        policy: async () => ({ flag: "proceed-and-flag" as const }),
      },
      read: async () => state,
      write: async (value: AskNotificationState) => {
        state = structuredClone(value);
      },
      now: () => now,
      digestMinutes: async () => minutes,
      send,
    };
    await createAskNotifications(args).refresh();
    now = 600_000;
    await createAskNotifications(args).refresh();
    expect(send).not.toHaveBeenCalled();
    asks[0]!.status = "answered";
    minutes = 5;
    send.mockRejectedValueOnce(new Error("delivery failed"));
    await expect(createAskNotifications(args).refresh()).rejects.toThrow(
      "delivery failed",
    );
    const notifications = createAskNotifications(args);
    await Promise.all([notifications.refresh(), notifications.refresh()]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "1 flagged Asks" }),
    );
    await createAskNotifications(args).refresh();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
