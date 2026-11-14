import type { SourceObjectKind } from "./contracts.js";

export interface SourceStorageScope {
  organisation_id: string;
  repository_id: string;
  security_domain_id: string;
}
export interface SourceTransaction {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface SourceCatalogDatabase {
  transaction<T>(body: (tx: SourceTransaction) => Promise<T>): Promise<T>;
}
export type ObjectLifecycle =
  | "UPLOADING"
  | "VERIFIED"
  | "QUARANTINED"
  | "DELETE_PENDING"
  | "ABSENT";
export interface StoredObject extends SourceStorageScope {
  object_id: string;
  kind: SourceObjectKind;
  size_bytes: string;
  tree_prefix: string | null;
  incarnation_id: string;
  storage_key: string;
  generation: string;
  state: ObjectLifecycle;
  verified_at?: string | null;
}
export interface VerifiedObject extends StoredObject {
  state: "VERIFIED";
}
export interface MultipartPart {
  part: number;
  etag: string;
  size_bytes: string;
}
export interface ObjectUpload extends StoredObject {
  backend_upload_id: string | null;
  multipart_parts: MultipartPart[];
  upload_id: string;
  operation_id: string;
  owner_principal_id: string | null;
  status: "UPLOADING" | "UNKNOWN" | "VERIFIED";
  expires_at: string;
}
export interface SourceObjectCatalog {
  begin(
    scope: SourceStorageScope,
    request: {
      operation_id: string;
      object_id: string;
      kind: SourceObjectKind;
      size_bytes: string;
      owner_principal_id?: string;
    },
  ): Promise<ObjectUpload>;
  lookup(
    scope: SourceStorageScope,
    object_id: string,
  ): Promise<StoredObject | null>;
  lookupMany?(
    scope: SourceStorageScope,
    object_ids: readonly string[],
  ): Promise<StoredObject[]>;
  upload(scope: SourceStorageScope, upload_id: string): Promise<ObjectUpload>;
  unknown(scope: SourceStorageScope, upload_id: string): Promise<void>;
  verify(
    scope: SourceStorageScope,
    upload_id: string,
    children: readonly string[],
    metadata?: { tree_prefix: string | null },
  ): Promise<VerifiedObject>;
}
export interface SourceMultipartCatalog extends SourceObjectCatalog {
  beginMultipart(
    scope: SourceStorageScope,
    upload_id: string,
    backend_upload_id: string,
  ): Promise<ObjectUpload>;
  recordMultipartPart(
    scope: SourceStorageScope,
    upload_id: string,
    backend_upload_id: string,
    part: MultipartPart,
  ): Promise<ObjectUpload>;
}
export type BackendRead =
  | { state: "PRESENT"; bytes: Buffer; etag: string | null }
  | { state: "ABSENT" | "UNKNOWN" };
export interface SourceObjectBackend {
  readonly identity: string;
  put(
    key: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<"ACKNOWLEDGED" | "EXISTS" | "UNKNOWN">;
  read(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<BackendRead>;
}
export interface SourceMultipartBackend extends SourceObjectBackend {
  initiateMultipart(
    key: string,
    signal?: AbortSignal,
  ): Promise<
    { state: "ACKNOWLEDGED"; upload_id: string } | { state: "UNKNOWN" }
  >;
  uploadPart(
    key: string,
    upload_id: string,
    part: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ state: "ACKNOWLEDGED"; etag: string } | { state: "UNKNOWN" }>;
  completeMultipart(
    key: string,
    upload_id: string,
    parts: readonly { part: number; etag: string }[],
    signal?: AbortSignal,
  ): Promise<"ACKNOWLEDGED" | "EXISTS" | "UNKNOWN">;
  abortMultipart(
    key: string,
    upload_id: string,
    signal?: AbortSignal,
  ): Promise<"ACKNOWLEDGED" | "UNKNOWN">;
}

export interface SourceBackendLifecycleRule {
  id: string | null;
  enabled: boolean;
  prefix: string;
  expiration: boolean;
  noncurrent_version_expiration: boolean;
}
export interface SourceBackendLifecycleConfiguration {
  versioning: "Enabled" | "Suspended" | "Unversioned";
  rules: SourceBackendLifecycleRule[];
}
export interface SourceDeletionBackend extends SourceObjectBackend {
  lifecycleConfiguration(
    signal?: AbortSignal,
  ): Promise<SourceBackendLifecycleConfiguration>;
  delete(
    key: string,
    expectedDigest: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<"ABSENT" | "UNKNOWN">;
}

export function sourceMultipartComplete(upload: ObjectUpload): boolean {
  return (
    upload.backend_upload_id === null ||
    (upload.multipart_parts.length > 0 &&
      upload.multipart_parts.every((part, index) => part.part === index + 1) &&
      upload.multipart_parts.reduce(
        (total, part) => total + BigInt(part.size_bytes),
        0n,
      ) === BigInt(upload.size_bytes))
  );
}
