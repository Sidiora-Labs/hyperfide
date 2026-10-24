import { eq, inArray } from "drizzle-orm";
import type {
  ProjectExecutionDefaults,
  PermissionMode,
  ReasoningLevel,
  ServiceTier,
} from "@hyperfide/domain";
import type { DbConnection } from "../connection.js";
import { projectExecutionDefaults } from "../schema.js";

export interface GetProjectExecutionDefaultsArgs {
  projectId: string;
}

export interface ListProjectExecutionDefaultsByProjectIdsArgs {
  projectIds: readonly string[];
}

export interface UpsertProjectExecutionDefaultsArgs extends GetProjectExecutionDefaultsArgs {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
}

export async function getProjectExecutionDefaults(
  db: DbConnection,
  args: GetProjectExecutionDefaultsArgs,
): Promise<ProjectExecutionDefaults | null> {
  const row = await db
    .select({
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .from(projectExecutionDefaults)
    .where(eq(projectExecutionDefaults.projectId, args.projectId))
    .get();

  return row ?? null;
}

export async function listProjectExecutionDefaultsByProjectIds(
  db: DbConnection,
  args: ListProjectExecutionDefaultsByProjectIdsArgs,
): Promise<Map<string, ProjectExecutionDefaults>> {
  const byProjectId = new Map<string, ProjectExecutionDefaults>();
  if (args.projectIds.length === 0) {
    return byProjectId;
  }

  const rows = await db
    .select({
      projectId: projectExecutionDefaults.projectId,
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .from(projectExecutionDefaults)
    .where(inArray(projectExecutionDefaults.projectId, [...args.projectIds]))
    .all();

  for (const row of rows) {
    const { projectId, ...defaults } = row;
    byProjectId.set(projectId, defaults);
  }
  return byProjectId;
}

export async function upsertProjectExecutionDefaults(
  db: DbConnection,
  args: UpsertProjectExecutionDefaultsArgs,
): Promise<ProjectExecutionDefaults> {
  const updatedAt = Date.now();
  const row = await db
    .insert(projectExecutionDefaults)
    .values({
      projectId: args.projectId,
      providerId: args.providerId,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      permissionMode: args.permissionMode,
      serviceTier: args.serviceTier,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [projectExecutionDefaults.projectId],
      set: {
        providerId: args.providerId,
        model: args.model,
        reasoningLevel: args.reasoningLevel,
        permissionMode: args.permissionMode,
        serviceTier: args.serviceTier,
        updatedAt,
      },
    })
    .returning({
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .get();

  return row;
}
