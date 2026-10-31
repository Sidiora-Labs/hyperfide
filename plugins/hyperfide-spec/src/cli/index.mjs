import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseKvx } from "../kvx.js";

/**
 * Native process adapter for the plugin CLI registration.
 * @param {import('./index.mjs').SpecCliOptions} options
 * @returns {import('./index.mjs').SpecCliRegistration}
 */
export function createSpecCli(options = {}) {
  const commands = ["next", "start", "implemented", "status"];
  return {
    name: "spec",
    summary: "Manage Hyperfide spec tasks",
    rendersHelp: true,
    commands: commands.map((name) => ({
      name,
      summary: `Run hyperfide spec ${name}`,
      usage: `hyperfide platform spec ${name}${["start", "implemented"].includes(name) ? " <id>" : ""} [-f <feature>] [--root DIR] [--json]`,
    })),
    async run(argv, ctx = {}) {
      if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
        return { exitCode: 0, stdout: "hyperfide platform spec next|start|implemented|status [-f <feature>] [--root DIR]\n" };
      }
      const value = (/** @type {string} */ flag) => {
        const index = argv.indexOf(flag);
        return index < 0 ? undefined : argv[index + 1];
      };
      const cwd = ctx.cwd ?? process.cwd();
      const root = resolve(cwd, value("--root") ?? process.env.HYPERFIDE_REPO_ROOT ?? ".");
      let activeFeature;
      try {
        const active = parseKvx(readFileSync(resolve(root, "spec/workflow.kvx"), "utf8")).get("meta")?.active_feature;
        if (typeof active === "string") activeFeature = active;
      } catch { /* The binary reports missing or invalid workflow files. */ }
      const feature = value("-f") ?? value("--feature") ?? activeFeature ?? "(repository feature)";
      const task = ["start", "implemented"].includes(argv[0]) ? argv[1] ?? "(missing)" : "(board)";
      const label = `feature ${feature}, task ${task}`;
      if (!commands.includes(argv[0])) {
        return { exitCode: 1, stderr: `hyperfide spec: ${label}: unsupported command ${argv[0]}\n` };
      }
      const localBinary = resolve(process.env.HYPERFIDE_REPO_ROOT ?? root, "cg");
      const binary = options.binary ?? process.env.HYPERFIDE_BIN ??
        (existsSync(localBinary) ? localBinary : "hyperfide");
      const result = await new Promise(/** @param {(result: {exitCode: number, stdout: string, stderr: string}) => void} finish */ (finish) => {
        const child = spawn(binary, ["spec", ...argv], {
          cwd, signal: ctx.signal, stdio: ["ignore", "pipe", "pipe"],
        });
        /** @type {Buffer[]} */
        const stdout = [];
        /** @type {Buffer[]} */
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => finish({ exitCode: 1, stdout: "", stderr: `${error.message}\n` }));
        child.on("close", (code, signal) => finish({
          exitCode: code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
          stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
        }));
      });
      if (result.exitCode !== 0) {
        result.stderr += `hyperfide spec: ${label}\n`;
      } else if (!argv.includes("--help") && !argv.includes("-h")) {
        const board = new URL(options.boardUrl ?? "/plugins/hyperfide-spec", options.serverUrl ?? process.env.HYPERFIDE_SERVER_URL ?? "http://127.0.0.1:38886");
        if (!feature.startsWith("(")) board.searchParams.set("feature", feature);
        result.stderr += `Board: ${board.href}\n`;
      }
      return result;
    },
  };
}

/**
 * @param {{cli: {register(value: import('./index.mjs').SpecCliRegistration): void}}} ctx
 * @param {import('./index.mjs').SpecCliOptions} options
 */
export function registerSpecCli(ctx, options = {}) {
  ctx.cli.register(createSpecCli(options));
}
