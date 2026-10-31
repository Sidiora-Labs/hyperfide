import type {
  MachineBootstrapApi,
  MachineBootstrapRequest,
} from "@hyperfide/plugin-sdk";
import {
  redact,
  type Credentials,
  type SandboxMachine,
} from "./machine-ops.js";

type BootstrapStore = Pick<
  import("@hyperfide/plugin-sdk").HyperfidePluginApi["storage"]["kv"],
  "get" | "set"
>;
export interface BootstrapState {
  phase: string;
  updatedAt: string | null;
  lastError: string | null;
}
const bootstrapKey = "railway/bootstrap";
export async function readBootstrapState(
  store: BootstrapStore,
): Promise<BootstrapState> {
  return (
    (await store.get<BootstrapState>(bootstrapKey)) ?? {
      phase: "not-started",
      updatedAt: null,
      lastError: null,
    }
  );
}

/** Adapt the sandbox executor to the server's enrollment bootstrap. Credentials use stdin. */
export async function enrollRailwayHost(
  machine: SandboxMachine,
  bootstrap: MachineBootstrapApi,
  request: Omit<MachineBootstrapRequest, "executor">,
  state?: { store: BootstrapStore; credentials?: Credentials },
): Promise<{ hostId: string }> {
  const record = async (phase: string, lastError: string | null = null) => {
    await state?.store.set(bootstrapKey, {
      phase,
      updatedAt: new Date().toISOString(),
      lastError,
    });
  };
  await record("enrolling");
  try {
    const result = await bootstrap.bootstrap({
      ...request,
      executor: {
        async exec(execution) {
          execution.signal.throwIfAborted();
          const path = `/tmp/hyperfide-enroll-${crypto.randomUUID()}`;
          const quote = (value: string) =>
            `'${value.replaceAll("'", "'\\''")}'`;
          await machine.writeFile(path, execution.stdin, { mode: 0o600 });
          try {
            const result = await machine.exec(
              `${execution.command.map(quote).join(" ")} < ${quote(path)}`,
              { timeoutSec: Math.ceil(execution.timeoutMs / 1000) },
            );
            execution.signal.throwIfAborted();
            execution.onOutput(result.stdout);
            execution.onOutput(result.stderr);
            return { exitCode: result.timedOut ? 124 : result.exitCode };
          } finally {
            await machine.exec(`rm -f ${quote(path)}`);
          }
        },
      },
    });
    await record("enrolled");
    return result;
  } catch (error) {
    await record(
      "failed",
      redact(
        error instanceof Error ? error.message : String(error),
        state?.credentials,
      ),
    );
    throw new Error(redact(error instanceof Error ? error.message : String(error), state?.credentials));
  }
}
