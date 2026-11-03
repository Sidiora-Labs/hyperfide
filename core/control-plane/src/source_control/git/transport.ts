import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createDeflate } from "node:zlib";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import {
  SourceControlError,
  parseSourceScope,
  type SourceScope,
} from "../contracts.js";
import { sourceDigest } from "../metadata.js";
import type {
  GitExportObject,
  GitPushResult,
  SourceGitCredential,
  SourceGitDestination,
  SourceGitTransport,
} from "./types.js";

const ZERO = "0".repeat(40),
  MAX_WIRE = 536870912,
  MAX_ADVERTISEMENT = 1048576,
  MAX_STATUS = 65536;
export function rawGitOid(value: string): string {
  if (!/^git:sha1:[0-9a-f]{40}$/.test(value))
    throw new SourceControlError(
      "UNSUPPORTED_GIT_FORMAT",
      "Expected an explicitly namespaced Git SHA-1 identity",
    );
  return value.slice(9);
}
export function gitRef(value: string): string {
  if (
    typeof value !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new SourceControlError(
      "INVALID_REF",
      "Publication requires an exact branch ref",
    );
  return value;
}
function packet(bytes: Uint8Array | string): Buffer {
  const body =
    typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  if (body.length > 65516)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Git packet exceeds protocol bound",
    );
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}
function packets(bytes: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length)
      throw new SourceControlError(
        "INVALID_GIT_RESPONSE",
        "Incomplete Git packet length",
      );
    const text = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(text))
      throw new SourceControlError(
        "INVALID_GIT_RESPONSE",
        "Invalid Git packet length",
      );
    const n = parseInt(text, 16);
    offset += 4;
    if (n === 0) continue;
    if (n < 4 || offset + n - 4 > bytes.length)
      throw new SourceControlError(
        "INVALID_GIT_RESPONSE",
        "Incomplete Git packet",
      );
    result.push(bytes.subarray(offset, offset + n - 4));
    offset += n - 4;
  }
  return result;
}
function advertisement(
  bytes: Buffer,
  ref: string,
): { oid: string | null; capabilities: Set<string> } {
  const lines = packets(bytes).filter(
    (line) => !line.toString("utf8").startsWith("# service="),
  );
  let oid: string | null = null;
  const capabilities = new Set<string>();
  for (const line of lines) {
    const text = line.toString("utf8").replace(/\n$/, ""),
      [record, caps] = text.split("\0");
    if (caps) for (const cap of caps.split(" ")) capabilities.add(cap);
    const match = /^([0-9a-f]{40}) (.+)$/.exec(record ?? "");
    if (!match)
      throw new SourceControlError(
        "INVALID_GIT_RESPONSE",
        "Invalid Git ref advertisement",
      );
    if (match[2] === ref)
      oid = match[1] === ZERO ? null : "git:sha1:" + match[1];
  }
  if (
    [...capabilities].some(
      (cap) => cap.startsWith("object-format=") && cap !== "object-format=sha1",
    )
  )
    throw new SourceControlError(
      "UNSUPPORTED_GIT_FORMAT",
      "Destination does not advertise SHA-1",
    );
  return { oid, capabilities };
}
function objectHeader(kind: GitExportObject["kind"], size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > 268435456)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Git object exceeds the transport bound",
    );
  const type = { commit: 1, tree: 2, blob: 3 }[kind];
  let remaining = Math.floor(size / 16),
    first = (type << 4) | (size % 16);
  const bytes: number[] = [];
  if (remaining) first |= 128;
  bytes.push(first);
  while (remaining) {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining ? 128 : 0));
  }
  return Buffer.from(bytes);
}
async function* pack(
  objects: readonly GitExportObject[],
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (objects.reduce((sum, object) => sum + object.size_bytes, 0) > 268435456)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Git pack exceeds its decoded byte budget",
    );
  if (objects.length > 65536)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Git pack object count exceeds its bound",
    );
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const digest = createHash("sha1");
  let sent = 0;
  const emit = (bytes: Uint8Array) => {
    sent += bytes.byteLength;
    if (sent > MAX_WIRE)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Git pack exceeds its wire budget",
      );
    digest.update(bytes);
    return bytes;
  };
  yield emit(header);
  for (const object of objects) {
    signal?.throwIfAborted();
    rawGitOid(object.oid);
    yield emit(objectHeader(object.kind, object.size_bytes));
    let size = 0;
    const identity = createHash("sha1").update(
      Buffer.from(`${object.kind} ${object.size_bytes}\0`),
    );
    async function* contents() {
      for await (const bytes of object.content()) {
        signal?.throwIfAborted();
        size += bytes.byteLength;
        if (size > object.size_bytes)
          throw new SourceControlError(
            "INVALID_GIT_OBJECT",
            "Git object changed during transfer",
          );
        identity.update(bytes);
        yield bytes;
      }
      if (
        size !== object.size_bytes ||
        identity.digest("hex") !== rawGitOid(object.oid)
      )
        throw new SourceControlError(
          "INVALID_GIT_OBJECT",
          "Git object length or identity changed during transfer",
        );
    }
    const source = Readable.from(contents()),
      compressed = createDeflate();
    source.on("error", (error) => compressed.destroy(error));
    compressed.on("close", () => source.destroy());
    source.pipe(compressed);
    for await (const bytes of compressed) yield emit(bytes as Buffer);
  }
  yield digest.digest();
}
function pushStatus(bytes: Buffer): GitPushResult {
  const messages = packets(bytes).map((line) => line.toString("utf8").trim());
  if (
    messages.some(
      (line) => line.startsWith("unpack ") && line !== "unpack ok",
    ) ||
    messages.some((line) => line.startsWith("ng "))
  )
    return { outcome: "REJECTED", code: "REMOTE_REJECTED" };
  if (
    messages.includes("unpack ok") &&
    messages.some((line) => line.startsWith("ok refs/heads/"))
  )
    return { outcome: "ACCEPTED", code: "REMOTE_ACCEPTED" };
  return { outcome: "UNKNOWN", code: "INCOMPLETE_REMOTE_STATUS" };
}
async function readAll(
  stream: AsyncIterable<Uint8Array>,
  maximum: number,
): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const bytes of stream) {
    size += bytes.byteLength;
    if (size > maximum)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Git remote response exceeds its byte budget",
      );
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
async function readAdvertisement(
  iterator: AsyncIterator<Uint8Array>,
): Promise<{ bytes: Buffer; rest: Buffer }> {
  let buffer = Buffer.alloc(0),
    offset = 0;
  for (;;) {
    while (offset + 4 <= buffer.length) {
      const text = buffer.subarray(offset, offset + 4).toString("ascii");
      if (!/^[0-9a-fA-F]{4}$/.test(text))
        throw new SourceControlError(
          "INVALID_GIT_RESPONSE",
          "Invalid advertisement packet",
        );
      const length = parseInt(text, 16);
      if (length === 0)
        return {
          bytes: buffer.subarray(0, offset + 4),
          rest: buffer.subarray(offset + 4),
        };
      if (length < 4)
        throw new SourceControlError(
          "INVALID_GIT_RESPONSE",
          "Invalid advertisement packet length",
        );
      if (offset + length > buffer.length) break;
      offset += length;
    }
    const part = await iterator.next();
    if (part.done)
      throw new SourceControlError(
        "INVALID_GIT_RESPONSE",
        "Missing advertisement flush",
      );
    buffer = Buffer.concat([buffer, Buffer.from(part.value)]);
    if (buffer.length > MAX_ADVERTISEMENT)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Git advertisement exceeds its byte budget",
      );
  }
}
function command(
  ref: string,
  old: string | null,
  next: string,
  capabilities: Set<string>,
): Buffer {
  gitRef(ref);
  if (!capabilities.has("report-status"))
    throw new SourceControlError(
      "UNSUPPORTED_GIT_CAPABILITY",
      "Destination lacks report-status",
    );
  return Buffer.concat([
    packet(
      `${old === null ? ZERO : rawGitOid(old)} ${rawGitOid(next)} ${ref}\0report-status\n`,
    ),
    Buffer.from("0000"),
  ]);
}
function localProcess(directory: string, signal?: AbortSignal) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 60000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const child = spawn(
    "git",
    ["-c", "receive.denyNonFastForwards=true", "receive-pack", directory],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LANG: "C",
      },
      signal: controller.signal,
    },
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const done = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  };
  child.once("close", done);
  return child;
}
export function createLocalGitDestination(input: {
  scope: SourceScope;
  id: string;
  repository_identity: string;
  path: string;
  allowed_refs: readonly string[];
}): SourceGitDestination {
  if (!path.isAbsolute(input.path))
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "Local Git destination requires an absolute path",
    );
  input.allowed_refs.forEach(gitRef);
  const pinnedPath = realpathSync(input.path),
    pinnedStat = statSync(pinnedPath);
  if (!pinnedStat.isDirectory())
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "Local Git destination must be a directory",
    );
  const localPath = async () => {
    const resolved = await realpath(input.path),
      current = statSync(resolved);
    if (
      resolved !== pinnedPath ||
      current.dev !== pinnedStat.dev ||
      current.ino !== pinnedStat.ino
    )
      throw new SourceControlError(
        "DESTINATION_CHANGED",
        "Local Git destination identity changed",
      );
    return resolved;
  };
  const transport: SourceGitTransport = {
    async observe(ref, signal) {
      gitRef(ref);
      const directory = await localPath(),
        child = localProcess(directory, signal);
      try {
        const iterator = child.stdout[Symbol.asyncIterator]();
        const advertised = await readAdvertisement(iterator);
        child.stdin.end();
        const result = advertisement(advertised.bytes, ref).oid;
        child.kill();
        return result;
      } finally {
        child.kill();
      }
    },
    async push(request) {
      const directory = await localPath(),
        child = localProcess(directory, request.signal);
      try {
        const iterator = child.stdout[Symbol.asyncIterator]();
        const advertised = await readAdvertisement(iterator),
          parsed = advertisement(advertised.bytes, request.target_ref);
        if (parsed.oid !== request.expected_old_oid) {
          child.stdin.end();
          return { outcome: "REJECTED", code: "REMOTE_DIVERGED" };
        }
        const write = async (bytes: Uint8Array) => {
          if (child.stdin.destroyed)
            throw new SourceControlError(
              "TRANSPORT_CLOSED",
              "Git input stream closed",
            );
          if (!child.stdin.write(bytes))
            await new Promise<void>((resolve, reject) => {
              const clean = () => {
                child.stdin.removeListener("drain", drain);
                child.stdin.removeListener("error", fail);
                child.stdin.removeListener("close", closed);
              };
              const drain = () => {
                clean();
                resolve();
              };
              const fail = (error: Error) => {
                clean();
                reject(error);
              };
              const closed = () =>
                fail(
                  new SourceControlError(
                    "TRANSPORT_CLOSED",
                    "Git input stream closed",
                  ),
                );
              child.stdin.once("drain", drain);
              child.stdin.once("error", fail);
              child.stdin.once("close", closed);
            });
        };
        await write(
          command(
            request.target_ref,
            request.expected_old_oid,
            request.new_oid,
            parsed.capabilities,
          ),
        );
        for await (const bytes of pack(request.objects, request.signal))
          await write(bytes);
        child.stdin.end();
        const rest = await readAll(
          {
            async *[Symbol.asyncIterator]() {
              if (advertised.rest.length) yield advertised.rest;
              for (;;) {
                const next = await iterator.next();
                if (next.done) break;
                yield next.value;
              }
            },
          },
          MAX_STATUS,
        );
        return pushStatus(rest);
      } catch {
        return { outcome: "UNKNOWN", code: "TRANSPORT_INTERRUPTED" };
      } finally {
        child.kill();
      }
    },
  };
  return {
    scope: parseSourceScope(input.scope),
    id: input.id,
    provider: "local",
    repository_identity: input.repository_identity,
    remote_key: sourceDigest([
      "git-remote",
      "local",
      pinnedPath,
      pinnedStat.dev,
      pinnedStat.ino,
    ]),
    configuration_digest: sourceDigest([
      "local",
      pinnedPath,
      pinnedStat.dev,
      pinnedStat.ino,
      input.repository_identity,
      input.allowed_refs,
    ]),
    allowed_refs: [...input.allowed_refs],
    transport,
  };
}
export function createHttpsGitTransport(input: {
  remote_url: string;
  credentials: () => Promise<SourceGitCredential>;
  fetch?: typeof globalThis.fetch;
}): SourceGitTransport {
  const url = new URL(input.remote_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "Git publication requires a trusted credential-free HTTPS URL",
    );
  const base = url.toString().replace(/\/$/, ""),
    transport = input.fetch ?? globalThis.fetch;
  const credential = async () => {
    const value = await input.credentials();
    if (
      !value.authorization_header ||
      /[\r\n]/.test(value.authorization_header) ||
      !Number.isFinite(Date.parse(value.expires_at)) ||
      Date.parse(value.expires_at) <= Date.now()
    )
      throw new SourceControlError(
        "EXPIRED_CREDENTIAL",
        "Git publication credential is unavailable or expired",
      );
    return value;
  };
  const advert = async (auth: SourceGitCredential, signal?: AbortSignal) => {
    const response = await transport(
      base + "/info/refs?service=git-receive-pack",
      {
        headers: {
          authorization: auth.authorization_header,
          accept: "application/x-git-receive-pack-advertisement",
        },
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok || !response.body)
      throw new SourceControlError(
        "REMOTE_UNAVAILABLE",
        "Git ref discovery failed",
      );
    return readAll(response.body, MAX_ADVERTISEMENT);
  };
  return {
    authorize: credential,
    async observe(ref, signal) {
      return advertisement(
        await advert(await credential(), signal),
        gitRef(ref),
      ).oid;
    },
    async push(request) {
      try {
        const auth = request.credential ?? (await credential()),
          parsed = advertisement(
            await advert(auth, request.signal),
            request.target_ref,
          );
        if (parsed.oid !== request.expected_old_oid)
          return { outcome: "REJECTED", code: "REMOTE_DIVERGED" };
        const prefix = command(
          request.target_ref,
          request.expected_old_oid,
          request.new_oid,
          parsed.capabilities,
        );
        async function* body() {
          yield prefix;
          yield* pack(request.objects, request.signal);
        }
        const response = await transport(base + "/git-receive-pack", {
          method: "POST",
          headers: {
            authorization: auth.authorization_header,
            "content-type": "application/x-git-receive-pack-request",
            accept: "application/x-git-receive-pack-result",
          },
          body: Readable.toWeb(
            Readable.from(body()),
          ) as ReadableStream<Uint8Array>,
          duplex: "half",
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(60000),
            ...(request.signal ? [request.signal] : []),
          ]),
        } as RequestInit & { duplex: "half" });
        if (!response.ok || !response.body)
          return { outcome: "UNKNOWN", code: "REMOTE_HTTP_FAILURE" };
        return pushStatus(await readAll(response.body, MAX_STATUS));
      } catch {
        return { outcome: "UNKNOWN", code: "TRANSPORT_INTERRUPTED" };
      }
    },
  };
}
