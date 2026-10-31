import { prepareCachedQuery } from "../connection.js";
import { hostPathEquals } from "./host-path-sql.js";
import { and, asc, desc, eq, isNull, placeholder } from "drizzle-orm";
import { PERSONAL_PROJECT_ID } from "@hyperfide/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projects, projectSources } from "../schema.js";
import { createProjectId, createProjectSourceId } from "../ids.js";
import { toProjectSource } from "./project-sources.js";
import { createOrderKeyAfter, createOrderKeyBetween } from "./order-keys.js";

export interface CreateProjectLocalPathSourceInput {
  type: "local_path";
  hostId: string;
  path: string;
}

export type CreateProjectSourceInput = CreateProjectLocalPathSourceInput;

export interface CreateProjectInput {
  name: string;
  source: CreateProjectSourceInput;
}

export type ProjectRow = typeof projects.$inferSelect;

export interface ReorderProjectArgs {
  db: DbConnection;
  nextProjectId: string | null;
  notifier: DbNotifier;
  previousProjectId: string | null;
  projectId: string;
}

interface ResolveProjectNeighborArgs {
  movedProjectId: string;
  neighborProjectId: string | null;
}

export interface ReorderProjectSuccess {
  kind: "reordered";
  projects: ProjectRow[];
}

export interface ReorderProjectUnchanged {
  kind: "unchanged";
  projects: ProjectRow[];
}

export interface ReorderProjectNotFound {
  kind: "not_found";
}

export interface ReorderProjectStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderProjectInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export type ReorderProjectResult =
  | ReorderProjectSuccess
  | ReorderProjectUnchanged
  | ReorderProjectNotFound
  | ReorderProjectStaleNeighbor
  | ReorderProjectInvalidNeighborOrder;

function publicProjectFilter() {
  return and(eq(projects.kind, "standard"), isNull(projects.deletedAt));
}

export async function listPublicProjects(
  db: DbQueryConnection,
): Promise<ProjectRow[]> {
  return await db
    .select()
    .from(projects)
    .where(publicProjectFilter())
    .orderBy(asc(projects.sortKey), asc(projects.id))
    .all();
}

async function getLastPublicProject(
  db: DbQueryConnection,
): Promise<ProjectRow | null> {
  return (
    (await db
      .select()
      .from(projects)
      .where(publicProjectFilter())
      .orderBy(desc(projects.sortKey), desc(projects.id))
      .limit(1)
      .get()) ?? null
  );
}

async function getPublicProjectForMutation(
  db: DbQueryConnection,
  id: string,
): Promise<ProjectRow | null> {
  return (
    (await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), publicProjectFilter()))
      .get()) ?? null
  );
}

async function getPublicProjectWithLocalPathSource(
  db: DbQueryConnection,
  source: CreateProjectLocalPathSourceInput,
) {
  return (
    (await db
      .select({ project: projects, source: projectSources })
      .from(projects)
      .innerJoin(projectSources, eq(projectSources.projectId, projects.id))
      .where(
        and(
          publicProjectFilter(),
          eq(projectSources.type, source.type),
          eq(projectSources.hostId, source.hostId),
          hostPathEquals(projectSources.path, source.path),
        ),
      )
      .orderBy(asc(projects.sortKey), asc(projects.id))
      .limit(1)
      .get()) ?? null
  );
}

export async function getPublicProjectByLocalPathSource(
  db: DbQueryConnection,
  source: CreateProjectLocalPathSourceInput,
): Promise<ProjectRow | null> {
  return (
    (await getPublicProjectWithLocalPathSource(db, source))?.project ?? null
  );
}

async function insertProject(tx: DbTransaction, input: CreateProjectInput) {
  const now = Date.now();
  const projectId = createProjectId();
  const sourceId = createProjectSourceId();
  const lastProject = await getLastPublicProject(tx);
  const sortKey = lastProject
    ? createOrderKeyAfter({ previousKey: lastProject.sortKey })
    : createOrderKeyBetween({ previousKey: null, nextKey: null });
  const project = await tx
    .insert(projects)
    .values({
      id: projectId,
      name: input.name,
      sortKey,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const source = await tx
    .insert(projectSources)
    .values({
      id: sourceId,
      projectId,
      type: input.source.type,
      hostId: input.source.hostId,
      path: input.source.path,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { project, source };
}

function notifyProjectCreated(notifier: DbNotifier, projectId: string): void {
  notifier.notifyProject(projectId, ["project-created"]);
  notifier.notifyProject(projectId, ["project-sources-changed"]);
}

async function resolveProjectNeighbor(
  db: DbQueryConnection,
  args: ResolveProjectNeighborArgs,
): Promise<ProjectRow | null | false> {
  if (args.neighborProjectId === null) {
    return null;
  }
  if (args.neighborProjectId === args.movedProjectId) {
    return false;
  }

  return (
    (await getPublicProjectForMutation(db, args.neighborProjectId)) ?? false
  );
}

export async function createProject(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectInput,
) {
  const { project, source } = await db.transaction(
    async (tx) => await insertProject(tx, input),
  );
  notifyProjectCreated(notifier, project.id);
  return { project, source: toProjectSource(source) };
}

export async function findOrCreateProjectByLocalPathSource(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectInput,
) {
  const { created, project, source } = await db.transaction(
    async (tx) => {
      const existing = await getPublicProjectWithLocalPathSource(
        tx,
        input.source,
      );
      if (existing) {
        return { created: false, ...existing };
      }
      return { created: true, ...(await insertProject(tx, input)) };
    },
    { behavior: "immediate" },
  );

  if (created) {
    notifyProjectCreated(notifier, project.id);
  }
  return { project, source: toProjectSource(source) };
}

const prepareGetProject = (db: DbQueryConnection) =>
  db
    .select()
    .from(projects)
    .where(eq(projects.id, placeholder("id")))
    .prepare();

export async function getProject(db: DbConnection, id: string) {
  return (await prepareCachedQuery(db, prepareGetProject).get({ id })) ?? null;
}

export async function getPersonalProject(db: DbConnection) {
  return (
    (await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, PERSONAL_PROJECT_ID),
          eq(projects.kind, "personal"),
        ),
      )
      .get()) ?? null
  );
}

export async function ensurePersonalProject(db: DbConnection) {
  const now = Date.now();
  await db
    .insert(projects)
    .values({
      id: PERSONAL_PROJECT_ID,
      kind: "personal",
      name: "Personal",
      sortKey: "V",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const project = await getPersonalProject(db);
  if (!project) {
    throw new Error("Personal project row was not created");
  }
  return project;
}

export interface UpdateProjectInput {
  name?: string;
}

export async function setProjectGitRemoteUrlIfMissing(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  gitRemoteUrl: string,
) {
  const updated = await db
    .update(projects)
    .set({ gitRemoteUrl, updatedAt: Date.now() })
    .where(and(eq(projects.id, id), isNull(projects.gitRemoteUrl)))
    .returning()
    .get();
  if (updated) {
    await notifier.notifyProject(id, ["project-updated"]);
  }
  return updated ?? null;
}

export interface MarkProjectDeletedArgs {
  deletedAt?: number;
  projectId: string;
}

export async function updateProject(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateProjectInput,
) {
  const now = Date.now();
  const updated = await db
    .update(projects)
    .set({ ...input, updatedAt: now })
    .where(eq(projects.id, id))
    .returning()
    .get();
  if (updated) {
    await notifier.notifyProject(id, ["project-updated"]);
  }
  return updated ?? null;
}

export async function markProjectDeleted(
  db: DbConnection | DbTransaction,
  notifier: DbNotifier,
  args: MarkProjectDeletedArgs,
) {
  const deletedAt = args.deletedAt ?? Date.now();
  const updated =
    (await db
      .update(projects)
      .set({
        deletedAt,
        updatedAt: deletedAt,
      })
      .where(and(eq(projects.id, args.projectId), isNull(projects.deletedAt)))
      .returning()
      .get()) ?? null;

  if (updated) {
    await notifier.notifyProject(args.projectId, ["project-updated"]);
  }

  return updated;
}

export async function reorderProject({
  db,
  nextProjectId,
  notifier,
  previousProjectId,
  projectId,
}: ReorderProjectArgs): Promise<ReorderProjectResult> {
  const result = await db.transaction(
    async (tx): Promise<ReorderProjectResult> => {
      const movedProject = await getPublicProjectForMutation(tx, projectId);
      if (!movedProject) {
        return { kind: "not_found" };
      }

      const previousProject = await resolveProjectNeighbor(tx, {
        movedProjectId: projectId,
        neighborProjectId: previousProjectId,
      });
      const nextProject = await resolveProjectNeighbor(tx, {
        movedProjectId: projectId,
        neighborProjectId: nextProjectId,
      });
      if (previousProject === false || nextProject === false) {
        return { kind: "stale_neighbor" };
      }
      if (
        previousProject !== null &&
        nextProject !== null &&
        previousProject.sortKey >= nextProject.sortKey
      ) {
        return { kind: "invalid_neighbor_order" };
      }

      const currentProjects = await listPublicProjects(tx);
      const currentIndex = currentProjects.findIndex(
        (project) => project.id === projectId,
      );
      const currentPreviousProjectId =
        currentProjects[currentIndex - 1]?.id ?? null;
      const currentNextProjectId =
        currentProjects[currentIndex + 1]?.id ?? null;
      if (
        currentPreviousProjectId === previousProjectId &&
        currentNextProjectId === nextProjectId
      ) {
        return {
          kind: "unchanged",
          projects: currentProjects,
        };
      }

      const sortKey = createOrderKeyBetween({
        previousKey: previousProject?.sortKey ?? null,
        nextKey: nextProject?.sortKey ?? null,
      });
      const updated = await tx
        .update(projects)
        .set({ sortKey, updatedAt: Date.now() })
        .where(eq(projects.id, projectId))
        .returning({ id: projects.id })
        .get();
      if (!updated) {
        return { kind: "stale_neighbor" };
      }

      return {
        kind: "reordered",
        projects: await listPublicProjects(tx),
      };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "reordered") {
    await notifier.notifyProject(projectId, ["project-order-changed"]);
  }
  return result;
}

export async function deleteProject(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .get();
  if (!existing) return false;
  await db.delete(projects).where(eq(projects.id, id)).run();
  await notifier.notifyProject(id, ["project-deleted"]);
  return true;
}
