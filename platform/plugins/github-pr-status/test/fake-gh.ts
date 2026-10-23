import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

interface FakeGhResponse {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function installFakeGh(
  responses: Record<string, FakeGhResponse>,
): Promise<{ readCalls(): Promise<string[][]> }> {
  const binPath = await makeTempDir("hyperfide-fake-gh-");
  const logPath = path.join(binPath, "gh.log");
  const scriptPath = path.join(binPath, "gh.cjs");
  await fs.writeFile(
    scriptPath,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_LOG, args.join("\\t") + "\\n");
const responses = JSON.parse(process.env.TEST_GH_RESPONSES);
const response = responses[args.slice(0, 2).join(" ")] ?? {};
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exitCode = response.exit ?? 0;
`,
  );
  const ghPath = path.join(
    binPath,
    process.platform === "win32" ? "gh.cmd" : "gh",
  );
  await fs.writeFile(
    ghPath,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0gh.cjs" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("TEST_GH_LOG", logPath);
  vi.stubEnv("TEST_GH_RESPONSES", JSON.stringify(responses));
  vi.stubEnv("PATH", `${binPath}${path.delimiter}${process.env.PATH ?? ""}`);
  return {
    async readCalls() {
      try {
        return (await fs.readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
    },
  };
}
