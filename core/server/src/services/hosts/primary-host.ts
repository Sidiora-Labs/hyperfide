import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHost } from "@hyperfide/db";
import { HOST_ID_FILE_NAME } from "@hyperfide/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  requireConnectedHostSession,
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";

type PrimaryHostDeps = Pick<AppDeps, "config" | "db" | "hub">;

interface ReadPrimaryHostIdArgs {
  dataDir: string;
}

interface AssertUsableHostIdArgs {
  hostId: string;
}

function primaryHostUnavailableError(): ApiError {
  return new ApiError(
    502,
    "host_unavailable",
    "Local host daemon is not initialized",
  );
}

export function readPrimaryHostIdFromDataDir(
  args: ReadPrimaryHostIdArgs,
): string | null {
  try {
    const value = readFileSync(
      join(args.dataDir, HOST_ID_FILE_NAME),
      "utf8",
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isServerMachineHost(
  deps: Pick<AppDeps, "config">,
  hostId: string,
): boolean {
  return (
    readPrimaryHostIdFromDataDir({ dataDir: deps.config.dataDir }) === hostId
  );
}

export async function resolvePrimaryHostId(
  deps: PrimaryHostDeps,
): Promise<string | null> {
  const configured = readPrimaryHostIdFromDataDir({
    dataDir: deps.config.dataDir,
  });
  const configuredHost =
    configured === null ? null : await getHost(deps.db, configured);
  return configuredHost?.destroyedAt === null ? configuredHost.id : null;
}

export async function requirePrimaryHostId(
  deps: PrimaryHostDeps,
): Promise<string> {
  const hostId = await resolvePrimaryHostId(deps);
  if (!hostId) {
    throw primaryHostUnavailableError();
  }
  return hostId;
}

export async function assertUsableHostId(
  deps: PrimaryHostDeps,
  args: AssertUsableHostIdArgs,
): Promise<void> {
  await requireNonDestroyedHostWithStatus(deps, args.hostId);
}

export async function requireConnectedPrimaryHostId(
  deps: PrimaryHostDeps,
): Promise<string> {
  const hostId = await requirePrimaryHostId(deps);
  await requireNonDestroyedHostWithStatus(deps, hostId);
  await requireConnectedHostSession(deps, hostId);
  return hostId;
}
