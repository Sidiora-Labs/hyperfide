import { expect, it } from "vitest";
import { runTaskThread, runBinary } from "./projection-run-task";
it("uses one thread creation path for workers and checkers", async () => {
  const requests: unknown[] = [];
  const host = { async createThread(request: unknown) { requests.push(request); return "echo"; } };
  for (const role of ["worker", "checker"] as const) {
    expect(await runTaskThread(host, { task: "4.3", provider: "echo", cwd: "/tmp", packet: "criteria", role }, { verify: () => runBinary("true", [], "/tmp") })).toBe("echo");
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ env: { CG_TASK: "4.3" }, role: "checker" });
});
