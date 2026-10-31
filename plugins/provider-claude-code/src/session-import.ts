import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  ThreadImportSourceDefinition,
  ThreadImportIO,
  ImportedSession,
} from "@hyperfide/plugin-sdk";
import { createClaudeTranscriptTranslator } from "./transcript-import.js";
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
  const source: string = "claude-code";
  let sessionId = "",
    cwd = "",
    title = "",
    prompt = "";
  let createdAt = Infinity,
    updatedAt = 0;
  for await (const { record } of records(path)) {
    const message = object(record.message);

    sessionId ||= typeof record.sessionId === "string" ? record.sessionId : "";
    cwd ||= typeof record.cwd === "string" ? record.cwd : "";
    if (record.type === "ai-title") {
      const value = record.aiTitle ?? record.title;
      if (typeof value === "string") title = value;
    }
    if (!prompt && record.type === "user" && record.isMeta !== true)
      prompt = textContent(message.content);

    const time = Date.parse(String(record.timestamp ?? ""));
    if (Number.isFinite(time)) {
      createdAt = Math.min(createdAt, time);
      updatedAt = Math.max(updatedAt, time);
    }
  }
  if (!sessionId) return null;
  const parentKey =
    basename(dirname(path)) === "subagents"
      ? basename(dirname(dirname(path)))
      : undefined;
  const key = parentKey
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

export const sessionImportSource: ThreadImportSourceDefinition = {
  kind: "claude-code",
  label: "Claude Code",
  keywords: ["claude code", "claude-code"],
  providerId: "provider-claude-code",
  root: () => join(homedir(), ".claude/projects"),
  discover: (root, io) => io.files(root),
  parse: (path, io) => parse(path, io.records),
  createTranslator: createClaudeTranscriptTranslator,
  suppressChildIdentity: true,
};
