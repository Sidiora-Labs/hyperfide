import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@hyperfide/plugin-sdk/host";
import {
  graphHostContract,
  hostInputSchema,
  resultSchema,
} from "./contract.js";
import { resolveBinary } from "./projected-binary-adapter.js";
const exec = promisify(execFile);
export async function runBinary(raw: unknown, parent?: AbortSignal) {
  const input = hostInputSchema.parse(raw);
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs),
    ...(parent ? [parent] : []),
  ]);
  try {
    const binary = await resolveBinary(
      input.repository,
      input.binaryPath,
      signal,
    );
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
  }
}
export default experimental_defineHostEntry({
  contract: graphHostContract,
  handlers: { run: (input, context) => runBinary(input, context.signal) },
});
