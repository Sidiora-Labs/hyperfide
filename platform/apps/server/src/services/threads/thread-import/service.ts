import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
  createEnvironment,
  createThread,
  ensurePersonalProject,
  findProjectEnvironmentByHostPath,
  getLatestThreadSequence,
  listProjectSourcesByHost,
  threadPluginMetadata,
  threads,
  events,
  updateThread,
  type AppendStoredThreadEventArgs,
  type DbConnection,
} from "@hyperfide/db";
import {
  threadScope,
  buildThreadEventRow,
  type ThreadEvent,
} from "@hyperfide/domain";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@hyperfide/plugin-sdk/provider-bridge/testing";
import type {
  ThreadImportRequest,
  ThreadImportResponse,
  ThreadImportSource,
} from "@hyperfide/server-contract";
import type { AppDeps } from "../../../types.js";
import { requirePrimaryHostId } from "../../hosts/primary-host.js";
import {
  createClaudeTranscriptTranslator,
  createCodexTranscriptTranslator,
} from "./provider-translators.mjs";

type Source = "claude-code" | "codex";
type Deps = Pick<AppDeps, "db" | "hub" | "config">;
interface Session {
  source: Source;
  path: string;
  sessionId: string;
  key: string;
  parentKey?: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
interface Cursor {
  source: Source;
  key: string;
  lines: number;
}
const IMPORT_METADATA = "hyperfideSessionImport";
const BATCH_SIZE = 200;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .map((part) => object(part).text)
        .filter((part) => typeof part === "string")
        .join("\n")
    : "";
}

// Snapshot the file and defer its last line until we know it was fully written.
async function* records(path: string) {
  const file = await open(path, "r");
  let stream: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    const { size } = await file.stat();
    if (!size) return;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    stream = file.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
    });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    let pending: string | undefined;
    let line = 0;
    function parse(value: string) {
      line++;
      if (!value.trim()) return { line, record: {} };
      try {
        return { line, record: object(JSON.parse(value)) };
      } catch {
        throw new Error(`Invalid JSON at line ${line}`);
      }
    }
    for await (const value of lines) {
      if (pending !== undefined) yield parse(pending);
      pending = value;
    }
    if (pending !== undefined && last[0] === 10) yield parse(pending);
  } finally {
    lines?.close();
    stream?.destroy();
    await file.close();
  }
}

async function* files(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (object(error).code === "ENOENT") return;
    throw error;
  }
  // Parent files precede their subagent directories.
  entries.sort(
    (a, b) =>
      Number(a.isDirectory()) - Number(b.isDirectory()) ||
      a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function roots(
  request: ThreadImportRequest,
): Array<{ source: Source; root: string }> {
  return (
    request.source ? [request.source] : (["claude-code", "codex"] as Source[])
  ).map((source) => ({
    source,
    root: resolve(
      request.root ??
        join(
          homedir(),
          source === "codex" ? ".codex/sessions" : ".claude/projects",
        ),
    ),
  }));
}

export async function discoverImportSources(
  request: ThreadImportRequest = {},
): Promise<{ sources: ThreadImportSource[] }> {
  const sources: ThreadImportSource[] = [];
  for (const root of roots(request)) {
    let count = 0;
    for await (const _path of files(root.root)) count++;
    sources.push({ ...root, count });
  }
  return { sources };
}

async function describeSession(
  source: Source,
  path: string,
): Promise<Session | null> {
  let sessionId = "",
    cwd = "",
    title = "",
    prompt = "";
  let codexParentKey: string | undefined;
  let createdAt = Infinity,
    updatedAt = 0;
  for await (const { record } of records(path)) {
    const payload = object(record.payload);
    const message = object(record.message);
    if (source === "claude-code") {
      sessionId ||=
        typeof record.sessionId === "string" ? record.sessionId : "";
      cwd ||= typeof record.cwd === "string" ? record.cwd : "";
      if (record.type === "ai-title") {
        const value = record.aiTitle ?? record.title;
        if (typeof value === "string") title = value;
      }
      if (!prompt && record.type === "user" && record.isMeta !== true)
        prompt = textContent(message.content);
    } else {
      if (record.type === "session_meta") {
        sessionId ||= typeof payload.id === "string" ? payload.id : "";
        cwd ||= typeof payload.cwd === "string" ? payload.cwd : "";
        const spawn = object(
          object(object(payload.source).subagent).thread_spawn,
        );
        if (typeof spawn.parent_thread_id === "string")
          codexParentKey = spawn.parent_thread_id;
      }
      if (record.type === "turn_context")
        cwd ||= typeof payload.cwd === "string" ? payload.cwd : "";
      if (!prompt && record.type === "response_item" && payload.role === "user")
        prompt = textContent(payload.content);
    }
    const time = Date.parse(String(record.timestamp ?? ""));
    if (Number.isFinite(time)) {
      createdAt = Math.min(createdAt, time);
      updatedAt = Math.max(updatedAt, time);
    }
  }
  if (!sessionId) return null;
  const parentKey =
    source === "claude-code" && basename(dirname(path)) === "subagents"
      ? basename(dirname(dirname(path)))
      : codexParentKey;
  const key =
    parentKey && source === "claude-code"
      ? `${parentKey}/${basename(path, ".jsonl")}`
      : sessionId;
  const fallback = (await stat(path)).mtimeMs;
  return {
    source,
    path,
    sessionId,
    key,
    parentKey,
    cwd,
    title: (title || prompt || sessionId).trim().slice(0, 240),
    createdAt: Number.isFinite(createdAt) ? createdAt : fallback,
    updatedAt: updatedAt || fallback,
  };
}

function cursorFromMetadata(metadata: string): Cursor | null {
  try {
    const cursor = object(JSON.parse(metadata))[IMPORT_METADATA];
    const value = object(cursor);
    return (value.source === "claude-code" || value.source === "codex") &&
      typeof value.key === "string" &&
      typeof value.lines === "number"
      ? (value as unknown as Cursor)
      : null;
  } catch {
    return null;
  }
}

async function importSession(
  deps: Deps,
  session: Session,
  known: Map<string, { threadId: string; cursor: Cursor }>,
  hostId: string | null,
  result: ThreadImportResponse,
) {
  if (!session.cwd || !isAbsolute(session.cwd))
    throw new Error("Session has no absolute working directory");
  const providerId = `provider-${session.source}`;
  const lookupKey = `${session.source}:${session.key}`;
  const existing = known.get(lookupKey);
  const parentThreadId = session.parentKey
    ? (known.get(`${session.source}:${session.parentKey}`)?.threadId ?? null)
    : null;
  const personal = await ensurePersonalProject(deps.db);
  const sources = hostId ? await listProjectSourcesByHost(deps.db, hostId) : [];
  const projectSource = sources
    .filter((source) => {
      if (!session.cwd) return false;
      const child = relative(resolve(source.path), resolve(session.cwd));
      return (
        !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
      );
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  const projectId = projectSource?.projectId ?? personal.id;
  let environmentId: string | null = null;
  if (!existing && hostId && session.cwd) {
    environmentId =
      (
        await findProjectEnvironmentByHostPath(
          deps.db,
          projectId,
          hostId,
          session.cwd,
        )
      )?.id ??
      (
        await createEnvironment(deps.db, deps.hub, {
          projectId,
          hostId,
          path: session.cwd,
          providerOwnsPath: false,
          status: "ready",
        })
      ).id;
  }
  const initialCursor: Cursor = {
    source: session.source,
    key: session.key,
    lines: 0,
  };
  const thread = existing
    ? await deps.db
        .select()
        .from(threads)
        .where(eq(threads.id, existing.threadId))
        .get()
    : await createThread(deps.db, deps.hub, {
        projectId,
        environmentId,
        providerId,
        title: session.title,
        status: "idle",
        parentThreadId,
        pluginMetadata: {
          pluginId: providerId,
          metadata: { [IMPORT_METADATA]: { ...initialCursor } },
        },
      });
  if (!thread) throw new Error("Imported thread no longer exists");
  if (existing && thread.title !== session.title) {
    await updateThread(deps.db, deps.hub, thread.id, { title: session.title });
  }
  if (existing && parentThreadId && thread.parentThreadId !== parentThreadId) {
    await updateThread(deps.db, deps.hub, thread.id, { parentThreadId });
  }
  const saved = existing?.cursor ?? initialCursor;
  known.set(lookupKey, { threadId: thread.id, cursor: saved });
  const translator =
    session.source === "claude-code"
      ? createClaudeTranscriptTranslator({
          cwd: session.cwd,
          threadId: thread.id,
        })
      : createCodexTranscriptTranslator({ threadId: thread.id });
  let timestamp = session.createdAt;
  const assembler = createDeltaAssembler({
    providerId,
    entropyPrefix: `import-${thread.id}`,
    textDeltaFlushMs: 0,
    progressThrottleMs: 0,
    now: () => timestamp,
  });
  let batch: Array<{ event: ThreadEvent; timestamp: number }> = [];
  let lineCount = 0,
    added = 0;
  async function flush(line: number) {
    if (line <= saved.lines && batch.length === 0) return;
    await persistBatch(
      deps.db,
      thread!.id,
      providerId,
      session,
      batch,
      line,
      thread!.environmentId,
    );
    added += batch.length;
    batch = [];
    saved.lines = line;
  }
  if (!existing && !(session.source === "claude-code" && session.parentKey))
    batch.push({
      event: {
        type: "thread/identity",
        threadId: thread.id,
        providerThreadId: session.sessionId,
        scope: threadScope(),
      },
      timestamp,
    });
  for await (const { line, record } of records(session.path)) {
    lineCount = line;
    const time = Date.parse(String(record.timestamp ?? ""));
    if (Number.isFinite(time)) timestamp = time;
    const translated = assembler.assemble({
      threadId: thread.id,
      deltas: translator.translate(record),
    });
    if (line > saved.lines)
      batch.push(
        ...translated
          .filter(
            (event) =>
              !(session.source === "claude-code" && session.parentKey) ||
              event.type !== "thread/identity",
          )
          .map((event) => ({ event, timestamp })),
      );
    if (batch.length >= BATCH_SIZE) {
      await flush(line);
      await setImmediate();
    }
  }
  await flush(lineCount);
  result.records += added;
  if (!existing) result.imported++;
  else if (added) result.updated++;
  result.threads.push({
    id: thread.id,
    title: session.title,
    providerId,
    providerThreadId: session.sessionId,
  });
  if (added) {
    await deps.hub.notifyThread(thread.id, ["events-appended"], {
      timelineSequence: await getLatestThreadSequence(deps.db, {
        threadId: thread.id,
      }),
    });
    await deps.hub.notifyProject(projectId, ["threads-changed"]);
  }
}

async function persistBatch(
  db: DbConnection,
  threadId: string,
  providerId: string,
  session: Session,
  batch: Array<{ event: ThreadEvent; timestamp: number }>,
  lines: number,
  environmentId: string | null,
) {
  await db.transaction(
    async (tx) => {
      const inputs = batch.map(
        ({ event }) =>
          ({
            type: event.type,
            scope: event.scope,
            threadId,
            environmentId,
            providerThreadId: session.sessionId,
            data: buildThreadEventRow({
              id: "",
              seq: 0,
              createdAt: 0,
              threadId,
              scope: event.scope,
              event: {
                ...event,
                threadId,
                ...("providerThreadId" in event
                  ? { providerThreadId: session.sessionId }
                  : {}),
              },
            }).data,
          }) as AppendStoredThreadEventArgs,
      );
      const sequences = await appendStoredThreadEventsInTransaction(tx, inputs);
      for (const [index, sequence] of sequences.entries())
        await tx
          .update(events)
          .set({ createdAt: batch[index].timestamp })
          .where(
            and(eq(events.threadId, threadId), eq(events.sequence, sequence)),
          );
      const current = await tx
        .select()
        .from(threadPluginMetadata)
        .where(
          and(
            eq(threadPluginMetadata.threadId, threadId),
            eq(threadPluginMetadata.pluginId, providerId),
          ),
        )
        .get();
      const metadata = current ? object(JSON.parse(current.metadataJson)) : {};
      metadata[IMPORT_METADATA] = {
        source: session.source,
        key: session.key,
        lines,
      };
      await tx
        .update(threadPluginMetadata)
        .set({ metadataJson: JSON.stringify(metadata) })
        .where(
          and(
            eq(threadPluginMetadata.threadId, threadId),
            eq(threadPluginMetadata.pluginId, providerId),
          ),
        );
      await tx
        .update(threads)
        .set({ createdAt: session.createdAt, updatedAt: session.updatedAt })
        .where(eq(threads.id, threadId));
    },
    { behavior: "immediate" },
  );
}

// Serialize imports per database so simultaneous UI/CLI requests cannot mint duplicate threads.
const imports = new WeakMap<DbConnection, Promise<unknown>>();
export async function importSessions(
  deps: Deps,
  request: ThreadImportRequest,
): Promise<ThreadImportResponse> {
  const prior = imports.get(deps.db) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(() => runImport(deps, request));
  imports.set(deps.db, operation);
  try {
    return await operation;
  } finally {
    if (imports.get(deps.db) === operation) imports.delete(deps.db);
  }
}
async function runImport(
  deps: Deps,
  request: ThreadImportRequest,
): Promise<ThreadImportResponse> {
  const result: ThreadImportResponse = {
    imported: 0,
    updated: 0,
    records: 0,
    threads: [],
    sources: (await discoverImportSources(request)).sources,
    errors: [],
  };
  const known = new Map<string, { threadId: string; cursor: Cursor }>();
  for (const row of await deps.db
    .select()
    .from(threadPluginMetadata)
    .where(
      inArray(threadPluginMetadata.pluginId, [
        "provider-claude-code",
        "provider-codex",
      ]),
    )
    .all()) {
    const cursor = cursorFromMetadata(row.metadataJson);
    if (cursor)
      known.set(`${cursor.source}:${cursor.key}`, {
        threadId: row.threadId,
        cursor,
      });
  }
  const hostId = request.dryRun ? null : await requirePrimaryHostId(deps);
  const children: Session[] = [];
  for (const root of roots(request))
    for await (const path of files(root.root)) {
      try {
        const session = await describeSession(root.source, path);
        if (!session) continue;
        if (session.parentKey) children.push(session);
        if (request.dryRun) {
          if (!known.has(`${session.source}:${session.key}`)) result.imported++;
          result.threads.push({
            id: `dry-run:${session.source}:${session.key}`,
            title: session.title,
            providerId: `provider-${session.source}`,
            providerThreadId: session.sessionId,
          });
        } else await importSession(deps, session, known, hostId, result);
      } catch (error) {
        // Error details deliberately exclude parser/provider messages, which can contain transcript text.
        result.errors.push({
          path,
          message:
            object(error).code === "EACCES"
              ? "Permission denied"
              : "Could not import session",
        });
      }
      await setImmediate();
    }
  if (!request.dryRun)
    for (const child of children) {
      const entry = known.get(`${child.source}:${child.key}`);
      const parent = known.get(`${child.source}:${child.parentKey}`);
      if (entry && parent) {
        const thread = await deps.db
          .select()
          .from(threads)
          .where(eq(threads.id, entry.threadId))
          .get();
        if (thread && thread.parentThreadId !== parent.threadId) {
          await updateThread(deps.db, deps.hub, thread.id, {
            parentThreadId: parent.threadId,
          });
          await deps.db
            .update(threads)
            .set({ updatedAt: child.updatedAt })
            .where(eq(threads.id, thread.id));
        }
      }
    }
  return result;
}
