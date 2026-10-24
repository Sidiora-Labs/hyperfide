import { hostPathEquals } from "./host-path-sql.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
} from "drizzle-orm";
import type { ProjectSource } from "@hyperfide/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hosts, projectSources } from "../schema.js";
import { createProjectSourceId } from "../ids.js";

type ProjectSourceRow = typeof projectSources.$inferSelect;

export interface CreateLocalPathProjectSourceInput {
  projectId: string;
  type: "local_path";
  hostId: string;
  path: string;
  isDefault?: boolean;
  ownsPath?: boolean;
}

export type CreateProjectSourceInput = CreateLocalPathProjectSourceInput;

export function toProjectSource(row: ProjectSourceRow): ProjectSource {
  if (!row.hostId || !row.path) {
    throw new Error(`Invalid local_path project source row: ${row.id}`);
  }
  return {
    id: row.id,
    projectId: row.projectId,
    type: "local_path",
    hostId: row.hostId,
    path: row.path,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectSourceInput,
) {
  const row = await db.transaction(async (tx) => {
    const now = Date.now();
    const id = createProjectSourceId();
    const existingSources = await tx
      .select({ id: projectSources.id })
      .from(projectSources)
      .where(eq(projectSources.projectId, input.projectId))
      .all();
    const shouldBeDefault =
      input.isDefault === true || existingSources.length === 0;

    if (shouldBeDefault) {
      await tx
        .update(projectSources)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(projectSources.projectId, input.projectId))
        .run();
    }

    return await tx
      .insert(projectSources)
      .values({
        id,
        projectId: input.projectId,
        type: input.type,
        hostId: input.hostId,
        path: input.path,
        isDefault: shouldBeDefault,
        ownsPath: input.ownsPath ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
  await notifier.notifyProject(input.projectId, ["project-sources-changed"]);
  return toProjectSource(row);
}

export async function listProjectSourcesByProjectIds(
  db: DbConnection,
  projectIds: readonly string[],
) {
  if (projectIds.length === 0) {
    return [];
  }

  return (
    await db
      .select()
      .from(projectSources)
      .where(inArray(projectSources.projectId, [...projectIds]))
      .all()
  ).map(toProjectSource);
}

export async function listProjectSourcesByHost(
  db: DbConnection,
  hostId: string,
) {
  return (
    await db
      .select()
      .from(projectSources)
      .where(eq(projectSources.hostId, hostId))
      .all()
  ).map(toProjectSource);
}

export interface GetProjectSourceForProjectArgs {
  projectId: string;
  sourceId: string;
}

export async function getProjectSourceForProject(
  db: DbConnection,
  args: GetProjectSourceForProjectArgs,
) {
  const source = await db
    .select()
    .from(projectSources)
    .where(
      and(
        eq(projectSources.id, args.sourceId),
        eq(projectSources.projectId, args.projectId),
      ),
    )
    .get();

  return source ? toProjectSource(source) : null;
}

export interface CountProjectSourcesArgs {
  projectId: string;
}

export async function countProjectSources(
  db: DbConnection,
  args: CountProjectSourcesArgs,
): Promise<number> {
  const row = await db
    .select({ count: count() })
    .from(projectSources)
    .where(eq(projectSources.projectId, args.projectId))
    .get();

  return row?.count ?? 0;
}

export interface UpdateLocalPathProjectSourceInput {
  path?: string;
  isDefault?: true;
}

export type UpdateProjectSourceInput = UpdateLocalPathProjectSourceInput;

export async function updateProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateProjectSourceInput,
) {
  const updated = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .get();
    if (!existing) {
      return null;
    }

    const now = Date.now();
    if (input.isDefault) {
      await tx
        .update(projectSources)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(projectSources.projectId, existing.projectId))
        .run();
    }
    const { isDefault: _isDefault, ...rest } = input;
    const updatedRow =
      (await tx
        .update(projectSources)
        .set({
          ...rest,
          ...(input.isDefault ? { isDefault: true } : {}),
          updatedAt: now,
        })
        .where(eq(projectSources.id, id))
        .returning()
        .get()) ?? null;

    return updatedRow
      ? { projectId: existing.projectId, row: updatedRow }
      : null;
  });
  if (!updated) {
    return null;
  }

  await notifier.notifyProject(updated.projectId, ["project-sources-changed"]);
  return toProjectSource(updated.row);
}

export async function getProjectSourceByHost(
  db: DbConnection,
  projectId: string,
  hostId: string,
) {
  const source =
    (await db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.hostId, hostId),
        ),
      )
      .get()) ?? null;
  return source ? toProjectSource(source) : null;
}

export async function getProjectSourceOnPersistentHost(
  db: DbConnection,
  projectId: string,
) {
  const row =
    (await db
      .select({ source: projectSources })
      .from(projectSources)
      .innerJoin(hosts, eq(hosts.id, projectSources.hostId))
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.type, "local_path"),
          eq(hosts.type, "persistent"),
          isNull(hosts.destroyedAt),
          notInArray(hosts.phase, ["removing", "destroyed"]),
        ),
      )
      .orderBy(
        desc(projectSources.isDefault),
        asc(projectSources.createdAt),
        asc(projectSources.id),
      )
      .limit(1)
      .get()) ?? null;
  return row ? toProjectSource(row.source) : null;
}

export async function deleteProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const deleted = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .get();
    if (!existing) {
      return null;
    }

    const now = Date.now();
    await tx.delete(projectSources).where(eq(projectSources.id, id)).run();
    if (existing.isDefault) {
      const replacement =
        (await tx
          .select()
          .from(projectSources)
          .where(eq(projectSources.projectId, existing.projectId))
          .get()) ?? null;
      if (replacement) {
        await tx
          .update(projectSources)
          .set({ isDefault: true, updatedAt: now })
          .where(
            and(
              eq(projectSources.id, replacement.id),
              ne(projectSources.id, id),
            ),
          )
          .run();
      }
    }
    return existing.projectId;
  });
  if (!deleted) {
    return false;
  }

  await notifier.notifyProject(deleted, ["project-sources-changed"]);
  return true;
}

export async function projectSourceOwnsPath(
  db: DbConnection,
  projectId: string,
  hostId: string,
  path: string,
): Promise<boolean> {
  return (
    (
      await db
        .select({ ownsPath: projectSources.ownsPath })
        .from(projectSources)
        .where(
          and(
            eq(projectSources.projectId, projectId),
            eq(projectSources.hostId, hostId),
            hostPathEquals(projectSources.path, path),
          ),
        )
        .get()
    )?.ownsPath ?? false
  );
}
