import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { MAX_JSON_RPC_LINE_BYTES } from "./bounded-line-reader.js";

export const PROVIDER_BRIDGE_RECORD_DIR_ENV = "HYPERFIDE_PROVIDER_BRIDGE_RECORD_DIR";

export const BRIDGE_RECORDING_DIRECTIONS = [
  "runtime→bridge",
  "bridge→runtime",
  "provider→bridge",
  "bridge→provider",
] as const;

export type BridgeRecordingDirection =
  (typeof BRIDGE_RECORDING_DIRECTIONS)[number];

export type BridgeRecordingRuntimeDirection = Extract<
  BridgeRecordingDirection,
  "runtime→bridge" | "bridge→runtime"
>;

export const BRIDGE_RECORDING_PROCESS_SCOPE = "_process";

export interface BridgeRecordingEntry {
  ts: number;
  run: number;
  seq: number;
  dir: BridgeRecordingDirection;
  line: string;
}

export function bridgeRecordingFileName(
  direction: BridgeRecordingDirection,
): string {
  return `${direction}.ndjson`;
}

export interface RecordBridgeLineArgs {
  direction: BridgeRecordingDirection;
  line: string;
  threadId: string | null;
}

export interface BridgeRecorderChildStreams {
  stdin?: Writable | null;
  stdout?: Readable | null;
}

export interface BridgeRecorder {
  record(args: RecordBridgeLineArgs): void;
  recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void;
  recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void;
  close(): void;
}

export function createRecordingLineSplitter(
  onLine: (line: string) => void,
  maxLineBytes: number = MAX_JSON_RPC_LINE_BYTES,
): { push: (chunk: string | Uint8Array) => void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  return {
    push(chunk) {
      const text =
        typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      let start = 0;
      for (;;) {
        const newlineIndex = text.indexOf("\n", start);
        if (newlineIndex === -1) {
          break;
        }
        if (!discarding) {
          const line = pending + text.slice(start, newlineIndex);
          onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
        discarding = false;
        pending = "";
        start = newlineIndex + 1;
      }
      if (discarding) {
        return;
      }
      pending += text.slice(start);
      if (Buffer.byteLength(pending) > maxLineBytes) {
        discarding = true;
        pending = "";
      }
    },
  };
}

function safeScopeSegment(threadId: string | null): string {
  if (threadId === null || threadId === "") {
    return BRIDGE_RECORDING_PROCESS_SCOPE;
  }
  const sanitized = threadId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return sanitized === "" || sanitized.startsWith("_")
    ? `t-${sanitized}`
    : sanitized;
}

interface ParsedRuntimeLine {
  id: string | number | undefined;
  method: string | undefined;
  threadId: string | undefined;
}

function parseRuntimeLine(line: string): ParsedRuntimeLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id =
    typeof record.id === "string" || typeof record.id === "number"
      ? record.id
      : undefined;
  const method = typeof record.method === "string" ? record.method : undefined;
  const params = record.params;
  const threadId =
    typeof params === "object" &&
    params !== null &&
    typeof (params as Record<string, unknown>).threadId === "string"
      ? ((params as Record<string, unknown>).threadId as string)
      : undefined;
  return { id, method, threadId };
}

function pendingKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

export function createBridgeRecorder(args: { dir: string }): BridgeRecorder {
  const dir = resolve(args.dir);
  const fds = new Map<string, number>();
  const runtimeRequestThreads = new Map<string, string | null>();
  const bridgeRequestThreads = new Map<string, string | null>();
  const run = Date.now();
  let seq = 0;
  let closed = false;

  function fdFor(scope: string, direction: BridgeRecordingDirection): number {
    const key = `${scope}\u0000${direction}`;
    const existing = fds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const scopeDir = join(dir, scope);
    mkdirSync(scopeDir, { recursive: true });
    const fd = openSync(
      join(scopeDir, bridgeRecordingFileName(direction)),
      "a",
    );
    fds.set(key, fd);
    return fd;
  }

  function record(recordArgs: RecordBridgeLineArgs): void {
    if (closed) {
      return;
    }
    seq += 1;
    const entry: BridgeRecordingEntry = {
      ts: Date.now(),
      run,
      seq,
      dir: recordArgs.direction,
      line: recordArgs.line,
    };
    try {
      writeSync(
        fdFor(safeScopeSegment(recordArgs.threadId), recordArgs.direction),
        `${JSON.stringify(entry)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `provider bridge recorder: failed to append to ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  function recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void {
    const parsed = parseRuntimeLine(line);
    let threadId: string | null = parsed?.threadId ?? null;
    if (parsed !== null && parsed.id !== undefined) {
      const key = pendingKey(parsed.id);
      if (parsed.method !== undefined) {
        (direction === "runtime→bridge"
          ? runtimeRequestThreads
          : bridgeRequestThreads
        ).set(key, threadId);
      } else {
        const pending =
          direction === "runtime→bridge"
            ? bridgeRequestThreads
            : runtimeRequestThreads;
        const owner = pending.get(key);
        if (owner !== undefined) {
          pending.delete(key);
          threadId = owner;
        }
      }
    }
    record({ direction, line, threadId });
  }

  function recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void {
    const { stdin, stdout } = child;
    if (stdout) {
      const splitter = createRecordingLineSplitter((line) =>
        record({
          direction: "provider→bridge",
          line,
          threadId: scope.threadId,
        }),
      );
      stdout.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    }
    if (stdin) {
      const splitter = createRecordingLineSplitter((line) =>
        record({
          direction: "bridge→provider",
          line,
          threadId: scope.threadId,
        }),
      );
      const originalWrite = stdin.write.bind(stdin);
      stdin.write = ((
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        splitter.push(chunk);
        return (originalWrite as (...args: unknown[]) => boolean)(
          chunk,
          ...rest,
        );
      }) as typeof stdin.write;
    }
  }

  return {
    record,
    recordRuntimeLine,
    recordChildIo,
    close() {
      closed = true;
      for (const fd of fds.values()) {
        try {
          closeSync(fd);
        } catch {}
      }
      fds.clear();
    },
  };
}

const RECORDER_GLOBAL_KEY = Symbol.for("bb.providerBridgeRecorder");

interface RecorderGlobalSlot {
  recorder: BridgeRecorder | null;
  resolved: boolean;
}

function globalSlot(): RecorderGlobalSlot {
  const holder = globalThis as unknown as Record<symbol, RecorderGlobalSlot>;
  const existing = holder[RECORDER_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const slot: RecorderGlobalSlot = { recorder: null, resolved: false };
  holder[RECORDER_GLOBAL_KEY] = slot;
  return slot;
}

export function getBridgeRecorder(): BridgeRecorder | null {
  const slot = globalSlot();
  if (!slot.resolved) {
    slot.resolved = true;
    const dir = process.env[PROVIDER_BRIDGE_RECORD_DIR_ENV];
    if (dir !== undefined && dir.trim() !== "") {
      slot.recorder = createBridgeRecorder({ dir: dir.trim() });
    }
  }
  return slot.recorder;
}

export function experimental_isProviderBridgeRecording(): boolean {
  return getBridgeRecorder() !== null;
}

export function experimental_recordProviderChildIo(
  child: BridgeRecorderChildStreams,
  scope: { threadId: string | null },
): void {
  getBridgeRecorder()?.recordChildIo(child, scope);
}
