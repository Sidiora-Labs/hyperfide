import { getProjectSourceByHost } from "@hyperfide/db";
import type { ProjectWorkspaceRoutingQuery } from "@hyperfide/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  assertUsableHostId,
  requirePrimaryHostId,
} from "../hosts/primary-host.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
} from "../lib/entity-lookup.js";

interface ProjectWorkspaceTarget {
  hostId: string;
  path: string;
}

interface ResolveProjectWorkspaceArgs extends ProjectWorkspaceRoutingQuery {
  projectId: string;
}

async function requireProjectEnvironment(
  deps: Pick<AppDeps, "db">,
  args: { environmentId: string; projectId: string; ready: boolean },
) {
  const environment = args.ready
    ? await requireReadyEnvironment(deps.db, args.environmentId)
    : await requireEnvironment(deps.db, args.environmentId);
  if (environment.projectId !== args.projectId) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return environment;
}

async function resolveProjectSourceOnHost(
  deps: Pick<AppDeps, "db">,
  args: { hostId: string; projectId: string },
): Promise<ProjectWorkspaceTarget | null> {
  const source = await getProjectSourceByHost(
    deps.db,
    args.projectId,
    args.hostId,
  );
  if (!source || source.type !== "local_path") {
    return null;
  }
  return { hostId: source.hostId, path: source.path };
}

export async function projectCheckoutPathOnHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): Promise<string | undefined> {
  return (await resolveProjectSourceOnHost(deps, { hostId, projectId }))?.path;
}

export async function resolveProjectWorkspaceTarget(
  deps: Pick<AppDeps, "config" | "db" | "hub">,
  args: ResolveProjectWorkspaceArgs,
): Promise<ProjectWorkspaceTarget> {
  if (args.environmentId !== undefined) {
    const environment = await requireProjectEnvironment(deps, {
      environmentId: args.environmentId,
      projectId: args.projectId,
      ready: true,
    });
    await assertUsableHostId(deps, { hostId: environment.hostId });
    if (environment.path === null) {
      throw new ApiError(
        409,
        "environment_not_ready",
        "Environment workspace is not ready",
      );
    }
    return { hostId: environment.hostId, path: environment.path };
  }

  const hostId = args.hostId ?? (await requirePrimaryHostId(deps));
  await assertUsableHostId(deps, { hostId });
  const source = await resolveProjectSourceOnHost(deps, {
    hostId,
    projectId: args.projectId,
  });
  if (source) {
    return source;
  }
  throw new ApiError(
    args.hostId !== undefined ? 404 : 409,
    "invalid_request",
    args.hostId !== undefined
      ? "Project has no local-path source for host"
      : "Project has no local-path source for the primary host",
  );
}

export interface ProjectCommandWorkspace {
  hostId: string;
  cwd: string | null;
}

export async function resolveProjectCommandWorkspace(
  deps: Pick<AppDeps, "config" | "db" | "hub">,
  args: ResolveProjectWorkspaceArgs,
): Promise<ProjectCommandWorkspace> {
  if (args.environmentId !== undefined) {
    const environment = await requireProjectEnvironment(deps, {
      environmentId: args.environmentId,
      projectId: args.projectId,
      ready: false,
    });
    await assertUsableHostId(deps, { hostId: environment.hostId });
    if (environment.status === "ready" && environment.path !== null) {
      return { hostId: environment.hostId, cwd: environment.path };
    }
    return {
      hostId: environment.hostId,
      cwd:
        (
          await resolveProjectSourceOnHost(deps, {
            hostId: environment.hostId,
            projectId: args.projectId,
          })
        )?.path ?? null,
    };
  }

  const hostId = args.hostId ?? (await requirePrimaryHostId(deps));
  await assertUsableHostId(deps, { hostId });
  return {
    hostId,
    cwd:
      (
        await resolveProjectSourceOnHost(deps, {
          hostId,
          projectId: args.projectId,
        })
      )?.path ?? null,
  };
}
