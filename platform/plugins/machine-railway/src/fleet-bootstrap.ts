import type { MachineBootstrapApi, MachineBootstrapRequest } from "@hyperfide/plugin-sdk";
import type { SandboxMachine } from "./machine-ops.js";

/** Adapt the sandbox executor to the server's enrollment bootstrap. Credentials use stdin. */
export async function enrollRailwayHost(machine: SandboxMachine, bootstrap: MachineBootstrapApi,
  request: Omit<MachineBootstrapRequest, "executor">): Promise<{ hostId: string }> {
  return bootstrap.bootstrap({ ...request, executor: {
    async exec(execution) {
      execution.signal.throwIfAborted();
      const path = `/tmp/hyperfide-enroll-${crypto.randomUUID()}`;
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await machine.writeFile(path, execution.stdin, { mode: 0o600 });
      try {
        const result = await machine.exec(`${execution.command.map(quote).join(" ")} < ${quote(path)}`, { timeoutSec: Math.ceil(execution.timeoutMs / 1000) });
        execution.signal.throwIfAborted();
        execution.onOutput(result.stdout);
        execution.onOutput(result.stderr);
        return { exitCode: result.timedOut ? 124 : result.exitCode };
      } finally { await machine.exec(`rm -f ${quote(path)}`); }
    },
  } });
}
