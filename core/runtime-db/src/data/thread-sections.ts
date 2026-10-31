import { asc, eq } from "drizzle-orm";
import { PERSONAL_PROJECT_ID } from "@hyperfide/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import { createThreadSectionId } from "../ids.js";
import type { DbNotifier } from "../notifier.js";
import { threadSections, threads } from "../schema.js";

type ThreadSectionWriteConnection = DbConnection | DbTransaction;

export type ThreadSectionRow = typeof threadSections.$inferSelect;

export interface CreateThreadSectionInput {
  name: string;
}

export interface RenameThreadSectionInput {
  id: string;
  name: string;
}

export interface DeleteThreadSectionInput {
  id: string;
}

export interface ThreadSectionMutationResult {
  id: string;
  name: string;
  updatedThreadCount: number;
}

export type CreateThreadSectionResult =
  | { status: "created"; section: ThreadSectionRow }
  | { status: "duplicate"; section: ThreadSectionRow };

export type RenameThreadSectionResult =
  | { status: "renamed"; result: ThreadSectionMutationResult }
  | { status: "duplicate"; section: ThreadSectionRow }
  | { status: "not_found" };

export function normalizeThreadSectionName(
  name: string | null | undefined,
): string | null {
  const normalized = (name ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function notifyThreadSectionListChanged(notifier: DbNotifier): void {
  notifier.notifyProject(PERSONAL_PROJECT_ID, ["threads-changed"]);
}

function notifyThreadSectionMutationProjects(
  notifier: DbNotifier,
  projectIds: ReadonlySet<string>,
): void {
  notifyThreadSectionListChanged(notifier);
  for (const projectId of projectIds) {
    notifier.notifyProject(projectId, ["threads-changed"]);
  }
}

export async function getThreadSectionById(
  db: DbQueryConnection,
  id: string,
): Promise<ThreadSectionRow | null> {
  return (
    (await db
      .select()
      .from(threadSections)
      .where(eq(threadSections.id, id))
      .get()) ?? null
  );
}

async function getThreadSectionByName(
  db: DbQueryConnection,
  name: string,
): Promise<ThreadSectionRow | null> {
  const normalized = normalizeThreadSectionName(name);
  if (!normalized) {
    return null;
  }
  return (
    (await db
      .select()
      .from(threadSections)
      .where(eq(threadSections.name, normalized))
      .get()) ?? null
  );
}

export async function listThreadSections(
  db: DbQueryConnection,
): Promise<ThreadSectionRow[]> {
  return await db
    .select()
    .from(threadSections)
    .orderBy(asc(threadSections.name), asc(threadSections.id))
    .all();
}

export async function createThreadSection(
  db: ThreadSectionWriteConnection,
  notifier: DbNotifier,
  input: CreateThreadSectionInput,
): Promise<CreateThreadSectionResult> {
  const name = normalizeThreadSectionName(input.name);
  if (!name) {
    throw new Error("Thread section name cannot be empty");
  }

  const existing = await getThreadSectionByName(db, name);
  if (existing) {
    return { status: "duplicate", section: existing };
  }

  const now = Date.now();
  const section = await db
    .insert(threadSections)
    .values({
      id: createThreadSectionId(),
      name,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  notifyThreadSectionListChanged(notifier);
  return { status: "created", section };
}

export async function renameThreadSection(
  db: DbConnection,
  notifier: DbNotifier,
  input: RenameThreadSectionInput,
): Promise<RenameThreadSectionResult> {
  const name = normalizeThreadSectionName(input.name);
  if (!name) {
    return { status: "not_found" };
  }

  return await db.transaction(
    async (tx) => {
      const existing = await getThreadSectionById(tx, input.id);
      if (!existing) {
        return { status: "not_found" };
      }

      if (existing.name === name) {
        return {
          status: "renamed",
          result: {
            id: existing.id,
            name: existing.name,
            updatedThreadCount: 0,
          },
        };
      }

      const duplicate = await getThreadSectionByName(tx, name);
      if (duplicate && duplicate.id !== input.id) {
        return { status: "duplicate", section: duplicate };
      }

      await tx
        .update(threadSections)
        .set({ name, updatedAt: Date.now() })
        .where(eq(threadSections.id, input.id))
        .run();
      notifyThreadSectionListChanged(notifier);
      return {
        status: "renamed",
        result: {
          id: input.id,
          name,
          updatedThreadCount: 0,
        },
      };
    },
    { behavior: "immediate" },
  );
}

export async function deleteThreadSection(
  db: DbConnection,
  notifier: DbNotifier,
  input: DeleteThreadSectionInput,
): Promise<ThreadSectionMutationResult | null> {
  return await db.transaction(
    async (tx) => {
      const section = await getThreadSectionById(tx, input.id);
      if (!section) {
        return null;
      }

      const matchingThreads = await tx
        .select({
          id: threads.id,
          projectId: threads.projectId,
        })
        .from(threads)
        .where(eq(threads.sectionId, input.id))
        .all();

      const now = Date.now();
      const affectedProjects = new Set<string>();
      await tx
        .update(threads)
        .set({ sectionId: null, updatedAt: now })
        .where(eq(threads.sectionId, input.id))
        .run();
      for (const thread of matchingThreads) {
        affectedProjects.add(thread.projectId);
        await notifier.notifyThread(thread.id, ["title-changed"], {
          projectId: thread.projectId,
        });
      }

      await tx
        .delete(threadSections)
        .where(eq(threadSections.id, input.id))
        .run();
      notifyThreadSectionMutationProjects(notifier, affectedProjects);
      return {
        id: section.id,
        name: section.name,
        updatedThreadCount: matchingThreads.length,
      };
    },
    { behavior: "immediate" },
  );
}
