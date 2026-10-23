// Task 1.3 integration seam: replace with the graph plugin's host daemon client.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, basename, resolve } from "node:path";
const execute = promisify(execFile);
export interface GraphHost {
  resolveRepository(
    repository: string,
  ): Promise<{ root: string; hostId: string }>;
  binaryPath(hostId: string): Promise<string>;
  exec(
    hostId: string,
    command: { binary: string; args: string[]; cwd: string },
  ): Promise<string>;
  readText(hostId: string, path: string): Promise<string | null>;
  watch(
    hostId: string,
    paths: string[],
    changed: () => void,
  ): Promise<() => void>;
}
export function localGraphHost(binary = "hyperfide"): GraphHost {
  return {
    async resolveRepository(repository) {
      return { root: resolve(repository), hostId: "local" };
    },
    async binaryPath() {
      return binary;
    },
    async exec(_host, { binary, args, cwd }) {
      return (
        await execute(binary, args, {
          cwd,
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;
    },
    async readText(_host, path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async watch(_host, paths, changed) {
      const watchers = [...new Set(paths.map(dirname))].map((directory) =>
        watch(directory, (_event, name) => {
          if (
            name === null ||
            paths.some((path) => basename(path) === String(name))
          )
            changed();
        }),
      );
      return () => watchers.forEach((watcher) => watcher.close());
    },
  };
}
