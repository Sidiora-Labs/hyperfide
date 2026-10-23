import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HyperfideStatus } from "@hyperfide/host-daemon-contract";

const run = promisify(execFile);
export async function inspectHyperfide(
  repository = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HyperfideStatus> {
  const status: HyperfideStatus = {
    path: null, version: null, digest: null, ok: false,
    checkedAt: Date.now(), repository: resolve(repository), index: null,
  };
  const candidates = env.HYPERFIDE_BIN
    ? [resolve(repository, env.HYPERFIDE_BIN)]
    : [join(repository, "cg"), ...(env.PATH ?? "").split(delimiter)
        .filter(Boolean).map((directory) => join(directory, process.platform === "win32" ? "hyperfide.exe" : "hyperfide"))];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      status.path = await realpath(candidate);
      break;
    } catch { /* Try the next resolution source. */ }
  }
  if (!status.path) return status;
  try {
    const before = await readFile(status.path);
    const { stdout } = await run(status.path, ["--version"], {
      cwd: repository, env, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    status.version = stdout.trim() || null;
    status.digest = createHash("sha256").update(before).digest("hex");
    status.ok = status.version !== null && before.equals(await readFile(status.path));
  } catch { return status; }
  if (status.ok) {
    try {
      await access(join(repository, ".codegraph"));
      const { stdout } = await run(status.path, ["index-status", "--json"], {
        cwd: repository, env, timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      const index: unknown = JSON.parse(stdout);
      if (index && typeof index === "object" && !Array.isArray(index)) {
        status.index = index as Record<string, unknown>;
      }
    } catch { /* Binary status remains useful if indexing is unavailable. */ }
  }
  status.checkedAt = Date.now();
  return status;
}
