import type { ThreadDelta } from "./provider-bridge.js";

export interface ImportedSession {
  source: string;
  path: string;
  sessionId: string;
  key: string;
  parentKey?: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface ThreadImportIO {
  files(root: string): AsyncIterable<string>;
  records(
    path: string,
  ): AsyncIterable<{ line: number; record: Record<string, unknown> }>;
}
/** Provider-owned session import adapter; the server supplies snapshot-safe file IO. */
export interface ThreadImportSourceDefinition {
  kind: string;
  label: string;
  keywords: readonly string[];
  providerId: string;
  root(): string;
  discover(root: string, io: ThreadImportIO): AsyncIterable<string>;
  parse(path: string, io: ThreadImportIO): Promise<ImportedSession | null>;
  createTranslator(options: { cwd: string; threadId: string }): {
    translate(record: Record<string, unknown>): ThreadDelta[];
  };
  suppressChildIdentity: boolean;
}
