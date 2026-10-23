// Local interface to task 1.2 until the daemon publishes its verified binary service.
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function resolveBinary(
  repository: string,
  override: string | undefined,
  signal: AbortSignal,
) {
  const explicit = override ?? process.env.HYPERFIDE_BIN;
  const candidates = explicit
    ? [explicit]
    : [
        resolve(repository, "cg"),
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .map((p) => resolve(p, "hyperfide")),
      ];
  for (const candidate of candidates) {
    const path = resolve(repository, candidate);
    try {
      await access(path, constants.X_OK);
    } catch {
      continue;
    }
    const { stdout } = await exec(path, ["--version"], {
      cwd: repository,
      signal,
      maxBuffer: 1024 * 1024,
    });
    return {
      path,
      version: stdout.trim(),
      digest: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      ok: true as const,
    };
  }
  throw new Error(
    "Hyperfide binary missing; configure binaryPath or HYPERFIDE_BIN on the host",
  );
}
