import { expect, it, vi } from "vitest";
import { createAskBridge, type BridgeCall } from "../client.js";

it("validates RPC replies before consumers use policy or thread context", async () => {
  const transport = vi.fn(async () => ({ question: "unknown-policy" }));
  const client = createAskBridge(transport as BridgeCall);
  await expect(client.policy("/repository")).rejects.toThrow();
  expect(transport).toHaveBeenCalledWith("policy", { repository: "/repository" });
  await expect(client.context("thread", "project")).rejects.toThrow();
});

it("normalizes canonical numeric Ask ids and nullable task bindings", async () => {
  const client = createAskBridge((async () => ({
    asks: [{
      id: 42, task: null, repository: "/repository", kind: "question",
      question: "Choose?", status: "open", deadline: null,
    }],
  })) as BridgeCall);
  expect((await client.list()).asks[0]).toMatchObject({ id: "42", task: "" });
});
