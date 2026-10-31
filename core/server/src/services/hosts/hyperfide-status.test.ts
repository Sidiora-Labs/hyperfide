import { expect, it } from "vitest";
import { getHyperfideStatus, recordHyperfideStatus } from "./hyperfide-status.js";
it("stores independent observations per server and host", () => {
  const owner = {};
  const status = { path: null, version: null, digest: null, ok: false, checkedAt: 1, repository: "/repo", index: null };
  recordHyperfideStatus(owner, "one", status);
  status.checkedAt = 2;
  expect(getHyperfideStatus(owner, "one")?.checkedAt).toBe(1);
  expect(getHyperfideStatus(owner, "two")).toBeNull();
  expect(getHyperfideStatus({}, "one")).toBeNull();
});
