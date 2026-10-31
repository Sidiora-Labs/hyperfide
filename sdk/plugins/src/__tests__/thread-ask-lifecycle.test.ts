import { expect, it } from "vitest";
import { createThreadAskLifecycle } from "../host.js";

it("records the pause before interrupting, then sends before clearing the reason", async () => {
  const calls: string[] = [];
  const lifecycle = createThreadAskLifecycle({
    async record(_id, event) { calls.push("resumed" in event ? "clear" : "record"); },
    async stop() { calls.push("stop"); },
    async send() { calls.push("send"); },
  });
  await lifecycle.pause("thread", { askId: "1", task: "task", reason: "Awaiting input" });
  await lifecycle.resume("thread", "answer");
  expect(calls).toEqual(["record", "stop", "send", "clear"]);
});

it("does not clear a pause if delivering the answer fails", async () => {
  const events: unknown[] = [];
  const lifecycle = createThreadAskLifecycle({
    async record(_id, event) { events.push(event); },
    async stop() {},
    async send() { throw new Error("offline"); },
  });
  await expect(lifecycle.resume("thread", "answer")).rejects.toThrow("offline");
  expect(events).toEqual([]);
});
