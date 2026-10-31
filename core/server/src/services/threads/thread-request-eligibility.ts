import {
  type LocalPathProjectSource,
  PERSONAL_PROJECT_ID,
} from "@hyperfide/domain";
import type { EnvironmentRow } from "@hyperfide/db";
import type { EnvironmentArgs } from "@hyperfide/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  assertUsableHostId,
  requireConnectedPrimaryHostId,
} from "../hosts/primary-host.js";
import { requireSourceForHost } from "./thread-create-helpers.js";

type ThreadRequestEnvironment = EnvironmentArgs;
type ThreadRequestEnvironmentDeps = Pick<AppDeps, "config" | "db" | "hub">;
type HostThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "host" }
>;
type WorkspaceBackedHostWorkspace = Exclude<
  HostThreadRequestEnvironment["workspace"],
  { type: "personal" }
>;
type ReuseThreadRequestEnvironment = Extract<
  ThreadRequestEnvironment,
  { type: "reuse" }
>;
interface ResolveStableThreadRequestEnvironmentArgs {
  allowUnmanagedPersonalProjectReuseEnvironmentId?: string;
  environment: ThreadRequestEnvironment;
  projectId: string;
}

interface ResolvedHostThreadRequestEnvironment {
  hostId: string;
  localSource: LocalPathProjectSource | null;
  type: "host";
  unmanagedPath: string | null;
  workspace: WorkspaceBackedHostWorkspace;
}

interface ResolvedReuseThreadRequestEnvironment {
  environment: EnvironmentRow;
  type: "reuse";
}

interface ResolvedPersonalThreadRequestEnvironment {
  hostId: string;
  type: "personal";
}

export type ResolvedStableThreadRequestEnvironment =
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment
  | ResolvedReuseThreadRequestEnvironment;

function requireHostEnvironmentId(
  environment: HostThreadRequestEnvironment,
): string {
  if (environment.hostId !== undefined) {
    return environment.hostId;
  }
  throw new ApiError(
    400,
    "invalid_request",
    "hostId is required for workspace-backed thread creation",
  );
}

function assertPersonalWorkspaceProjectCompatibility(projectId: string): void {
  if (projectId !== PERSONAL_PROJECT_ID) {
    throw new ApiError(
      400,
      "invalid_request",
      "Personal workspaces are only supported for the personal project",
    );
  }
}

function isPersonalWorkspaceEnvironment(environment: EnvironmentRow): boolean {
  return (
    environment.projectId === PERSONAL_PROJECT_ID &&
    environment.environmentProviderId !== null
  );
}

function assertReuseWorkspaceProjectCompatibility(
  projectId: string,
  environment: EnvironmentRow,
  allowUnmanagedPersonalProjectReuseEnvironmentId: string | undefined,
): void {
  const projectIsPersonal = projectId === PERSONAL_PROJECT_ID;
  const environmentIsPersonal = isPersonalWorkspaceEnvironment(environment);
  if (
    projectIsPersonal &&
    !environmentIsPersonal &&
    allowUnmanagedPersonalProjectReuseEnvironmentId !== environment.id
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Personal project threads must reuse a personal workspace",
    );
  }
  if (!projectIsPersonal && environmentIsPersonal) {
    throw new ApiError(
      409,
      "invalid_request",
      "Standard project threads cannot reuse personal workspaces",
    );
  }
}

async function resolveHostThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: HostThreadRequestEnvironment,
  projectId: string,
): Promise<
  | ResolvedHostThreadRequestEnvironment
  | ResolvedPersonalThreadRequestEnvironment
> {
  if (environment.workspace.type === "personal") {
    assertPersonalWorkspaceProjectCompatibility(projectId);
    const hostId =
      environment.hostId ?? (await requireConnectedPrimaryHostId(deps));
    await assertUsableHostId(deps, { hostId });
    return {
      hostId,
      type: "personal",
    };
  }

  const hostId = requireHostEnvironmentId(environment);
  await assertUsableHostId(deps, { hostId });

  if (
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path !== null
  ) {
    return {
      hostId,
      localSource: null,
      type: "host",
      unmanagedPath: environment.workspace.path,
      workspace: environment.workspace,
    };
  }

  const localSource = await requireSourceForHost(deps, projectId, hostId);

  return {
    hostId,
    localSource,
    type: "host",
    unmanagedPath:
      environment.workspace.type === "unmanaged" ? localSource.path : null,
    workspace: environment.workspace,
  };
}

export async function resolveReuseThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  environment: ReuseThreadRequestEnvironment,
  projectId: string,
  allowUnmanagedPersonalProjectReuseEnvironmentId: string | undefined,
): Promise<ResolvedReuseThreadRequestEnvironment> {
  let reusedEnvironment = await requireEnvironment(
    deps.db,
    environment.environmentId,
  );
  if (reusedEnvironment.projectId !== projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different project",
    );
  }
  assertReuseWorkspaceProjectCompatibility(
    projectId,
    reusedEnvironment,
    allowUnmanagedPersonalProjectReuseEnvironmentId,
  );
  await assertUsableHostId(deps, { hostId: reusedEnvironment.hostId });
  await assertEnvironmentPathAvailable(deps, {
    hostId: reusedEnvironment.hostId,
    path: reusedEnvironment.path ?? reusedEnvironment.claimPath,
    threadId: null,
  });
  reusedEnvironment = await requireEnvironment(
    deps.db,
    environment.environmentId,
  );
  if (reusedEnvironment.ownerThreadId !== null) {
    throw new ApiError(
      409,
      "workspace_busy",
      reusedEnvironment.path === null
        ? "Environment is still being prepared"
        : "Cannot checkout branch while another thread is using this workspace",
    );
  }
  return {
    environment: reusedEnvironment,
    type: "reuse",
  };
}

export async function resolveStableThreadRequestEnvironment(
  deps: ThreadRequestEnvironmentDeps,
  args: ResolveStableThreadRequestEnvironmentArgs,
): Promise<ResolvedStableThreadRequestEnvironment> {
  switch (args.environment.type) {
    case "host":
      return await resolveHostThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
      );
    case "reuse":
      return await resolveReuseThreadRequestEnvironment(
        deps,
        args.environment,
        args.projectId,
        args.allowUnmanagedPersonalProjectReuseEnvironmentId,
      );
    default: {
      const exhaustiveCheck: never = args.environment;
      throw new Error(
        `Unsupported thread request environment: ${exhaustiveCheck}`,
      );
    }
  }
}
