import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import {
  ProjectAttachmentError,
  type ProjectAttachmentOwnershipMode,
} from "@hyperfide/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  projectAttachments,
  projectAttachmentThreads,
  projectAttachmentBackfills,
  threads,
} from "../schema.js";

export const PROJECT_ATTACHMENT_GRACE_MS = 7 * 24 * 60 * 60_000;
export const PROJECT_ATTACHMENT_BATCH_SIZE = 32;
export type ProjectAttachmentRow = typeof projectAttachments.$inferSelect;

export async function getProjectAttachment(
  db: DbQueryConnection,
  projectId: string,
  storedPath: string,
) {
  return await db
    .select()
    .from(projectAttachments)
    .where(
      and(
        eq(projectAttachments.projectId, projectId),
        eq(projectAttachments.storedPath, storedPath),
      ),
    )
    .get();
}

export function attachmentUnavailable(path: string): ProjectAttachmentError {
  return new ProjectAttachmentError(
    `Attachment ${path} was not uploaded for this project or has expired. Upload it again before sending; relative workspace file paths are not valid attachment references.`,
  );
}

export async function recordProjectAttachment(
  db: DbQueryConnection,
  input: Omit<ProjectAttachmentRow, "id" | "deletionClaimedAt">,
): Promise<ProjectAttachmentRow> {
  await db
    .insert(projectAttachments)
    .values({ ...input, id: randomUUID(), deletionClaimedAt: null })
    .onConflictDoNothing({
      target: [projectAttachments.projectId, projectAttachments.storedPath],
    })
    .run();
  const row = await getProjectAttachment(db, input.projectId, input.storedPath);
  if (!row || row.deletionClaimedAt !== null)
    throw attachmentUnavailable(input.storedPath);
  return row;
}

export async function acquireProjectAttachmentOwnership(
  db: DbQueryConnection,
  threadId: string,
  paths: readonly string[],
  mode: ProjectAttachmentOwnershipMode = "required",
): Promise<void> {
  if (paths.length === 0) return;
  await db.transaction(
    async (tx) => {
      const thread = await tx
        .select({ projectId: threads.projectId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .get();
      if (!thread) throw new Error(`Thread ${threadId} does not exist`);
      for (const path of paths) {
        const attachment = await getProjectAttachment(
          tx,
          thread.projectId,
          path,
        );
        if (
          !attachment ||
          attachment.readyAt === null ||
          attachment.deletionClaimedAt !== null
        ) {
          if (mode === "best-effort") continue;
          throw attachmentUnavailable(path);
        }
        await tx
          .insert(projectAttachmentThreads)
          .values({ attachmentId: attachment.id, threadId })
          .onConflictDoNothing()
          .run();
      }
    },
    { behavior: "immediate" },
  );
}

export async function copyProjectAttachmentOwnership(
  db: DbQueryConnection,
  sourceThreadId: string,
  targetThreadId: string,
): Promise<void> {
  const source = await db
    .select({ projectId: threads.projectId })
    .from(threads)
    .where(eq(threads.id, sourceThreadId))
    .get();
  const target = await db
    .select({ projectId: threads.projectId })
    .from(threads)
    .where(eq(threads.id, targetThreadId))
    .get();
  if (!source || !target || source.projectId !== target.projectId)
    throw new Error(
      "Attachment ownership requires threads in the same project",
    );
  await db.run(sql`INSERT OR IGNORE INTO project_attachment_threads (attachment_id, thread_id)
    SELECT attachment_id, ${targetThreadId} FROM project_attachment_threads WHERE thread_id = ${sourceThreadId}`);
}

export async function claimProjectAttachments(
  db: DbConnection,
  projectId: string,
  now: number,
): Promise<ProjectAttachmentRow[]> {
  return await db.transaction(
    async (tx) => {
      const ready = await tx
        .select()
        .from(projectAttachmentBackfills)
        .where(
          and(
            eq(projectAttachmentBackfills.projectId, projectId),
            eq(projectAttachmentBackfills.phase, "done"),
          ),
        )
        .get();
      if (!ready) return [];
      const unowned = notExists(
        tx
          .select({ id: projectAttachmentThreads.threadId })
          .from(projectAttachmentThreads)
          .where(
            eq(projectAttachmentThreads.attachmentId, projectAttachments.id),
          ),
      );
      const eligible = await tx
        .select()
        .from(projectAttachments)
        .where(
          and(
            eq(projectAttachments.projectId, projectId),
            lt(projectAttachments.createdAt, now - PROJECT_ATTACHMENT_GRACE_MS),
            isNull(projectAttachments.deletionClaimedAt),
            unowned,
          ),
        )
        .orderBy(asc(projectAttachments.createdAt))
        .limit(PROJECT_ATTACHMENT_BATCH_SIZE)
        .all();
      for (const row of eligible)
        await tx
          .update(projectAttachments)
          .set({ deletionClaimedAt: now })
          .where(eq(projectAttachments.id, row.id))
          .run();
      const claimed = await tx
        .select()
        .from(projectAttachments)
        .where(
          and(
            eq(projectAttachments.projectId, projectId),
            sql`${projectAttachments.deletionClaimedAt} IS NOT NULL`,
          ),
        )
        .orderBy(
          asc(projectAttachments.deletionClaimedAt),
          asc(projectAttachments.id),
        )
        .limit(PROJECT_ATTACHMENT_BATCH_SIZE)
        .all();
      for (const row of claimed)
        await tx
          .update(projectAttachments)
          .set({ deletionClaimedAt: now })
          .where(eq(projectAttachments.id, row.id))
          .run();
      return claimed;
    },
    { behavior: "immediate" },
  );
}
