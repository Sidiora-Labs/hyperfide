import { resetConfiguredDatabase } from "../lib/reset-configured-database.js";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { resolveContainedPath } from "@hyperfide/process-utils";
import {
  bold,
  confirmTypedWord,
  cyan,
  dim,
  green,
  yellow,
  log,
  endStep,
} from "../lib/script-helpers.js";
import { resolveDevDataDir } from "../lib/dev-restart-utils.js";
import { runMainIfEntrypoint } from "../lib/script-entry.js";
import {
  resolveRuntimeDataDir,
  resolveRuntimeMode,
  type HyperfideRuntimeMode,
} from "@hyperfide/config/runtime";

function resolveResetDataDir(mode: HyperfideRuntimeMode): string {
  if (mode === "dev") {
    return resolveDevDataDir();
  }

  return resolveRuntimeDataDir({
    env: process.env,
    homeDir: homedir(),
    mode,
  });
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((pathValue) => resolve(pathValue)))];
}

export function resolveResetTargets(args: Set<string>): string[] {
  const mode = resolveRuntimeMode();

  if (args.has("--all")) {
    return uniquePaths([
      resolveRuntimeDataDir({
        env: process.env,
        homeDir: homedir(),
        mode: "prod",
      }),
      resolveDevDataDir(),
    ]);
  }

  return [resolveResetDataDir(mode)];
}

export function ensureSafeTargets(targets: string[]): void {
  const home = resolve(homedir());
  for (const target of targets) {
    if (!isAbsolute(target)) {
      throw new Error(`Refusing to remove non-absolute path: ${target}`);
    }
    const resolvedTarget = resolve(target);
    const containedTarget = resolveContainedPath({
      rootPath: home,
      candidatePath: resolvedTarget,
    });
    if (!containedTarget) {
      throw new Error(`Refusing to remove unsafe path: ${target}`);
    }
  }
}

export function renderHelpText(): string {
  return `
  ${bold("hyperfide reset")}

  ${dim("Usage")}
    pnpm reset -- [--all] [--yes]

  ${dim("Options")}
    --all   Remove prod and this checkout's dev data directories
    --yes   Skip the interactive confirmation prompt

  ${dim("Notes")}
    Removes hyperfide-managed state directories (${dim("~/.hyperfide")}, ${dim("~/.hyperfide-dev/<checkout-instance>")}).
    Does not touch external provider config managed by other tools.
    Production resets respect HYPERFIDE_DATA_DIR. Development resets always target this checkout's dev data directory.
\n`;
}

async function confirmReset(targets: string[]): Promise<boolean> {
  return await confirmTypedWord({
    renderIntro: () => {
      process.stdout.write("\n");
      log(
        yellow("!"),
        "This will permanently delete hyperfide-managed local data at:",
      );
      for (const target of targets) {
        log(" ", dim(target));
      }
      process.stdout.write("\n");
      log(
        " ",
        dim("Provider auth/config managed outside hyperfide will be left untouched."),
      );
      process.stdout.write("\n");
    },
    word: "reset",
  });
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = new Set(argv);

  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(renderHelpText());
    return;
  }

  process.stdout.write(`\n  ${bold("hyperfide reset")}\n`);

  const targets = resolveResetTargets(args);
  ensureSafeTargets(targets);

  const proceed = args.has("--yes") ? true : await confirmReset(targets);
  if (!proceed) {
    process.stdout.write("\n");
    log(dim("●"), "Reset cancelled");
    process.stdout.write("\n");
    return;
  }

  process.stdout.write("\n");

  if (process.env.HYPERFIDE_DATABASE_URL)
    await resetConfiguredDatabase(process.env.HYPERFIDE_DATABASE_URL);

  let removedCount = 0;
  for (const target of targets) {
    if (!existsSync(target)) {
      endStep(dim("–"), `${dim("skip")}  ${target} ${dim("(not found)")}`);
      continue;
    }
    rmSync(target, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
    endStep(green("✓"), `${cyan(target)}`);
    removedCount += 1;
  }

  process.stdout.write("\n");

  if (removedCount === 0) {
    log(dim("●"), "No hyperfide-managed data directories were present");
  } else {
    log(green("●"), bold("Reset complete"));
  }

  process.stdout.write("\n");
}

runMainIfEntrypoint(import.meta.url, main);
