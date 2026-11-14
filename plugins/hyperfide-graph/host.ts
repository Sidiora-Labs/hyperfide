import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  createSignedSourceClient,
  type SignedSourceConfiguration,
} from "@hyperfide/source-control/signed";
import { experimental_defineHostEntry } from "@hyperfide/plugin-sdk/host";
import {
  graphHostContract,
  hostInputSchema,
  resultSchema,
  nativeSourceSchema,
  NativeGraphRefusal,
} from "./contract.js";
import { inspectHyperfide } from "../../core/host-daemon/src/hyperfide-status.js";
const exec = promisify(execFile);
export async function runBinary(raw: unknown, parent?: AbortSignal) {
  const input = hostInputSchema.parse(raw);
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs),
    ...(parent ? [parent] : []),
  ]);
  if (input.nativeSource || process.env.HF_SOURCE_CONFIG !== undefined) {
    const filename = process.env.HF_SOURCE_CONFIG;
    if (
      !filename ||
      !path.isAbsolute(filename) ||
      path.resolve(filename) !== filename
    )
      throw new NativeGraphRefusal(
        "NATIVE_SOURCE_CONFIG_REQUIRED",
        "Configure an absolute HF_SOURCE_CONFIG for native graph access",
      );
    let config: any;
    let configured;
    try {
      const handle = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size < 1 ||
          stat.size > 131072 ||
          stat.nlink !== 1 ||
          (stat.mode & 0o022) !== 0
        )
          throw new Error(
            "Native source configuration must be a bounded protected file",
          );
        const bytes = Buffer.alloc(131073);
        let length = 0;
        for (;;) {
          const part = await handle.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          length += part.bytesRead;
          if (length > 131072)
            throw new Error("Native source configuration exceeds its limit");
          if (!part.bytesRead) break;
        }
        const after = await handle.stat();
        if (
          length !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error("Native source configuration changed while reading");
        config = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      } finally {
        await handle.close();
      }
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Native source configuration must be an object");
      configured =
        config.nativeSource === undefined
          ? undefined
          : nativeSourceSchema.parse(config.nativeSource);
    } catch (error) {
      throw new NativeGraphRefusal(
        "NATIVE_SOURCE_CONFIG_INVALID",
        "Native source configuration is unavailable or invalid",
        { cause: error },
      );
    }
    const source = input.nativeSource ?? configured;
    if (!source)
      throw new NativeGraphRefusal(
        "NATIVE_GRAPH_PIN_REQUIRED",
        "Native graph access requires an exact published build, revision and root tree pin",
      );
    if (
      configured &&
      ["buildId", "revisionId", "rootTreeId"].some(
        (key) =>
          configured[key as "buildId" | "revisionId" | "rootTreeId"] !==
          source[key as "buildId" | "revisionId" | "rootTreeId"],
      )
    )
      throw new NativeGraphRefusal(
        "NATIVE_GRAPH_SOURCE_MISMATCH",
        "Requested native graph differs from the configured source pin",
      );
    let client;
    try {
      client = await createSignedSourceClient(
        (config.transport ?? config) as SignedSourceConfiguration,
      );
    } catch (error) {
      throw new NativeGraphRefusal(
        "NATIVE_SOURCE_CONFIG_INVALID",
        "Native source transport configuration is invalid",
        { cause: error },
      );
    }
    const data = await client.call<Record<string, unknown>>(
      "source.graph.query",
      {
        build_id: source.buildId,
        revision_id: source.revisionId,
        root_tree_id: source.rootTreeId,
        mode:
          input.command === "index-status"
            ? "status"
            : input.command === "context"
              ? "context"
              : input.command === "why"
                ? "dependencies"
                : "symbols",
        ...(input.target
          ? input.command === "survey"
            ? { q: input.target }
            : { path: input.target }
          : {}),
        limit: 32,
        ...(source.cursor ? { cursor: source.cursor } : {}),
      },
      {
        signal,
        ...(config.assignment?.authority
          ? { authority: config.assignment.authority }
          : {}),
      },
    );
    return resultSchema.parse({
      binary: null,
      source: {
        revisionId: source.revisionId,
        rootTreeId: source.rootTreeId,
        buildId: source.buildId,
      },
      data,
    });
  }
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
      throw new Error(
        "Hyperfide binary missing or failed verification; configure binaryPath or HYPERFIDE_BIN on the host",
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
  } finally {
    if (cancelInspection) signal.removeEventListener("abort", cancelInspection);
  }
}
export default experimental_defineHostEntry({
  contract: graphHostContract,
  handlers: { run: (input, context) => runBinary(input, context.signal) },
});
