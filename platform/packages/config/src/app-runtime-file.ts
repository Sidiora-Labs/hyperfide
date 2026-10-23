import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { isProcessRunning } from "./verified-process-stop.js";

const HYPERFIDE_APP_RUNTIME_FILE_NAME = "hyperfide-app-runtime.json";

const hyperfideAppRuntimeFileSchema = z.object({
  entryPath: z.string().min(1),
  pid: z.number().int().positive(),
  surface: z.string().min(1),
  serverUrl: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type HyperfideAppRuntimeFile = z.infer<typeof hyperfideAppRuntimeFileSchema>;

interface WriteHyperfideAppRuntimeFileArgs {
  dataDir: string;
  entryPath: string;
  pid: number;
  serverUrl: string;
  startedAt: string;
  surface: string;
  version: string;
}

export function formatHyperfideAppRuntimeFilePath(dataDir: string): string {
  return join(dataDir, HYPERFIDE_APP_RUNTIME_FILE_NAME);
}

export async function writeHyperfideAppRuntimeFile(
  args: WriteHyperfideAppRuntimeFileArgs,
): Promise<void> {
  const runtimeFile: HyperfideAppRuntimeFile = {
    entryPath: args.entryPath,
    pid: args.pid,
    serverUrl: args.serverUrl,
    startedAt: args.startedAt,
    surface: args.surface,
    version: args.version,
  };
  await mkdir(args.dataDir, { recursive: true });
  await writeFile(
    formatHyperfideAppRuntimeFilePath(args.dataDir),
    `${JSON.stringify(runtimeFile, null, 2)}\n`,
    "utf8",
  );
}

export async function claimHyperfideAppRuntimeFile(
  args: WriteHyperfideAppRuntimeFileArgs & { isRunning?: (pid: number) => boolean },
): Promise<boolean> {
  const isRunning = args.isRunning ?? isProcessRunning;
  const existing = await readHyperfideAppRuntimeFile(args.dataDir);
  if (
    existing !== null &&
    existing.pid !== args.pid &&
    isRunning(existing.pid)
  ) {
    return false;
  }
  await writeHyperfideAppRuntimeFile(args);
  return true;
}

async function clearHyperfideAppRuntimeFile(dataDir: string): Promise<void> {
  await rm(formatHyperfideAppRuntimeFilePath(dataDir), { force: true });
}

export async function clearOwnHyperfideAppRuntimeFile(args: {
  dataDir: string;
  pid: number;
}): Promise<boolean> {
  const runtimeFile = await readHyperfideAppRuntimeFile(args.dataDir);
  if (runtimeFile === null || runtimeFile.pid !== args.pid) {
    return false;
  }
  await clearHyperfideAppRuntimeFile(args.dataDir);
  return true;
}

export function hyperfideAppRuntimeVerifyTokens(entryPath: string): string[] {
  return [entryPath, basename(entryPath)];
}

export async function readHyperfideAppRuntimeFile(
  dataDir: string,
): Promise<HyperfideAppRuntimeFile | null> {
  let rawContents: string;
  try {
    rawContents = await readFile(formatHyperfideAppRuntimeFilePath(dataDir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = hyperfideAppRuntimeFileSchema.safeParse(JSON.parse(rawContents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
