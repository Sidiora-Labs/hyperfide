import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ThreadImportSourceDefinition,
  ThreadImportIO,
  ImportedSession,
} from "@hyperfide/plugin-sdk";
import { createCodexTranscriptTranslator } from "./transcript-import.js";
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

async function parse(
  path: string,
  records: ThreadImportIO["records"],
): Promise<ImportedSession | null> {
  const source: string = "codex";
  let sessionId = "",
    cwd = "",
    title = "",
    prompt = "";
  let codexParentKey: string | undefined;
  let createdAt = Infinity,
    updatedAt = 0;
  for await (const { record } of records(path)) {
    const payload = object(record.payload);

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

    const time = Date.parse(String(record.timestamp ?? ""));
    if (Number.isFinite(time)) {
      createdAt = Math.min(createdAt, time);
      updatedAt = Math.max(updatedAt, time);
    }
  }
  if (!sessionId) return null;
  const parentKey = codexParentKey;
  const key = sessionId;
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

export const sessionImportSource: ThreadImportSourceDefinition = {
  kind: "codex",
  label: "Codex",
  keywords: ["codex"],
  providerId: "provider-codex",
  root: () => join(homedir(), ".codex/sessions"),
  discover: (root, io) => io.files(root),
  parse: (path, io) => parse(path, io.records),
  createTranslator: createCodexTranscriptTranslator,
  suppressChildIdentity: false,
};
