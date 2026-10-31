import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@hyperfide/plugin-sdk/host";
import {
  graphHostContract,
  hostInputSchema,
  resultSchema,
} from "./contract.js";
import { inspectHyperfide } from "../../core/host-daemon/src/hyperfide-status.js";
const exec = promisify(execFile);
export async function runBinary(raw: unknown, parent?: AbortSignal) {
  const input = hostInputSchema.parse(raw);
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs),
    ...(parent ? [parent] : []),
  ]);
  let cancelInspection: (() => void) | undefined;
  try {
    const binary = await Promise.race([
      inspectHyperfide(input.repository, {
        ...process.env,
        ...(input.binaryPath ? { HYPERFIDE_BIN: input.binaryPath } : {}),
      }),
      new Promise<never>((_, reject) => {
        cancelInspection = () => reject(signal.reason);
        signal.addEventListener("abort", cancelInspection, { once: true });
        if (signal.aborted) cancelInspection();
      }),
    ]);
    signal.throwIfAborted();
    if (!binary.ok || !binary.path)
      throw new Error("Hyperfide binary missing or failed verification; configure binaryPath or HYPERFIDE_BIN on the host");
    const args = [
      input.command,
      ...(input.target ? [input.target] : []),
      "--json",
    ];
    const { stdout } = await exec(binary.path, args, {
      cwd: input.repository,
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    return resultSchema.parse({ binary, data: JSON.parse(stdout) });
  } catch (error) {
    if (signal.aborted)
      throw new Error("Graph command timed out or cancelled", { cause: error });
    throw error;
  } finally {
    if (cancelInspection) signal.removeEventListener("abort", cancelInspection);
  }
}
export default experimental_defineHostEntry({
  contract: graphHostContract,
  handlers: { run: (input, context) => runBinary(input, context.signal) },
});
