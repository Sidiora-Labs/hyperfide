import { expect, it } from "vitest";
import { hostDaemonDaemonWsMessageSchema } from "./session.js";
it("validates binary observations on the daemon wire", () => {
  const message = { type: "hyperfide.status", status: { path: "/repo/cg", version: "hyperfide 22", digest: "a".repeat(64), ok: true, checkedAt: 1, repository: "/repo", index: { symbols: 42 } } };
  expect(hostDaemonDaemonWsMessageSchema.safeParse(message).success).toBe(true);
  expect(hostDaemonDaemonWsMessageSchema.safeParse({ ...message, status: { ...message.status, digest: "invalid" } }).success).toBe(false);
});
