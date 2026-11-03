import { createHash } from "node:crypto";
import {
  parseGitIdentity,
  parsePublicProvenance,
  parseRepositoryPath,
  SourceControlError,
} from "../contracts.js";
import type { PublicProvenance } from "../contracts.js";

export type GitObjectKind = "blob" | "tree" | "commit";
export type GitObjectId = `git:sha1:${string}`;
export interface GitProjectedObject {
  readonly object_format: "sha1";
  readonly oid: GitObjectId;
  readonly kind: GitObjectKind;
  readonly size_bytes: number;
  content(): AsyncIterable<Uint8Array>;
}
export interface GitTreeEntry {
  name: string;
  mode: "100644" | "100755" | "120000" | "040000";
  oid: string;
}

export function rawGitOID(value: string): string {
  if (typeof value !== "string" || !value.startsWith("git:sha1:"))
    throw new SourceControlError(
      "INVALID_GIT_IDENTITY",
      "A namespaced SHA-1 Git object identity is required",
    );
  return parseGitIdentity({ object_format: "sha1", oid: value.slice(9) }).oid;
}

export function gitObjectHeader(kind: GitObjectKind, size: number): Buffer {
  if (
    !["blob", "tree", "commit"].includes(kind) ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new SourceControlError(
      "INVALID_GIT_OBJECT",
      "A bounded Git object kind and size are required",
    );
  return Buffer.from(`${kind} ${size}\0`, "ascii");
}

export function gitObjectId(
  kind: GitObjectKind,
  payload: Uint8Array,
): GitObjectId {
  return `git:sha1:${createHash("sha1").update(gitObjectHeader(kind, payload.byteLength)).update(payload).digest("hex")}`;
}

export async function gitStreamObjectId(
  kind: GitObjectKind,
  size: number,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<GitObjectId> {
  const hash = createHash("sha1").update(gitObjectHeader(kind, size));
  let read = 0;
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    if (
      !(chunk instanceof Uint8Array) ||
      !Number.isSafeInteger(read + chunk.byteLength) ||
      read + chunk.byteLength > size
    )
      throw new SourceControlError(
        "GIT_OBJECT_INTEGRITY",
        "Git content exceeds its declared object size",
      );
    read += chunk.byteLength;
    hash.update(chunk);
  }
  if (read !== size)
    throw new SourceControlError(
      "GIT_OBJECT_INTEGRITY",
      "Git content does not match its declared object size",
    );
  return `git:sha1:${hash.digest("hex")}`;
}

export function gitTreePayload(input: readonly GitTreeEntry[]): Buffer {
  const entries = input
    .map((entry) => {
      const name = parseRepositoryPath(entry.name);
      if (name.includes("/") || name.toLowerCase() === ".git")
        throw new SourceControlError(
          "UNSUPPORTED_GIT_PATH",
          "A native path cannot be represented safely in a Git tree",
        );
      if (!["100644", "100755", "120000", "040000"].includes(entry.mode))
        throw new SourceControlError(
          "UNSUPPORTED_GIT_MODE",
          "The native entry mode has no supported Git representation",
        );
      const mode = entry.mode === "040000" ? "40000" : entry.mode;
      return {
        name,
        mode,
        raw: rawGitOID(entry.oid),
        order: Buffer.from(
          name + (entry.mode === "040000" ? "/" : "\0"),
          "utf8",
        ),
      };
    })
    .sort((left, right) => Buffer.compare(left.order, right.order));
  const names = new Set<string>(),
    parts: Buffer[] = [];
  for (const entry of entries) {
    if (names.has(entry.name))
      throw new SourceControlError(
        "INVALID_GIT_TREE",
        "Duplicate Git tree names are not permitted",
      );
    names.add(entry.name);
    parts.push(
      Buffer.from(entry.mode + " " + entry.name + "\0", "utf8"),
      Buffer.from(entry.raw, "hex"),
    );
  }
  return Buffer.concat(parts);
}

export function gitCommitPayload(
  tree: string,
  parents: readonly string[],
  input: PublicProvenance,
): Buffer {
  const provenance = parsePublicProvenance(input),
    { name, email } = provenance.author;
  if (
    !name ||
    !email ||
    /[\x00-\x1f\x7f<>]/.test(name + email) ||
    name.trim() !== name ||
    email.trim() !== email ||
    provenance.message.includes("\0")
  )
    throw new SourceControlError(
      "UNSUPPORTED_GIT_METADATA",
      "Public provenance cannot be represented by Git author and message fields",
    );
  const timestamp = Math.floor(Date.parse(provenance.timestamp) / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new SourceControlError(
      "UNSUPPORTED_GIT_METADATA",
      "Git publication requires a nonnegative integer author timestamp",
    );
  if (parents.length > 256 || new Set(parents).size !== parents.length)
    throw new SourceControlError(
      "INVALID_GIT_COMMIT",
      "Git parent identities must be ordered and unique",
    );
  const identity = `${name} <${email}> ${timestamp} +0000`;
  return Buffer.from(
    `tree ${rawGitOID(tree)}\n${parents.map((parent) => `parent ${rawGitOID(parent)}\n`).join("")}author ${identity}\ncommitter ${identity}\n\n${provenance.message}`,
    "utf8",
  );
}
