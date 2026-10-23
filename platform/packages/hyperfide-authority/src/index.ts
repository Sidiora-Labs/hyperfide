import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import https from "node:https";

export interface AuthorityConfiguration {
  url: string;
  caFile: string;
  keyFile: string;
  credentialId: string;
  runId: string;
  deadlineMs?: number;
  maxConcurrent?: number;
}
export interface Operator {
  credential_id: string;
  actor_id: string;
  organisation_id: string;
  run_id: string;
  role: "OPERATOR";
  expires_at: string;
}
export interface Receipt {
  id: string;
  kind: "lane" | "publication";
  subject: string;
  commit: string;
  evidence_digest: string;
  details: Record<string, unknown>;
}
export type AuthorityWrite =
  | { kind: "receipt"; receipt: Receipt }
  | { kind: "evidence"; digest: string; bytes_b64: string };
export interface TransactionIdentity { operationId: string; idempotencyKey: string }
export class AuthorityError extends Error {
  constructor(public readonly code: string, message: string, public readonly operationId?: string) {
    super(message);
    this.name = "AuthorityError";
  }
}
export const digest = (bytes: Uint8Array | string): string =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const limit = 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Undefined URL preserves local operation without opening files or making requests. */
export function authorityConfiguration(env: NodeJS.ProcessEnv): AuthorityConfiguration | undefined {
  if (!env.HYPERFIDE_AUTHORITY_URL) return undefined;
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new AuthorityError("AUTHORITY_CONFIG", `Missing ${name}`);
    return value;
  };
  return {
    url: env.HYPERFIDE_AUTHORITY_URL,
    caFile: required("HYPERFIDE_AUTHORITY_CA_FILE"),
    keyFile: required("HYPERFIDE_AUTHORITY_KEY_FILE"),
    credentialId: required("HYPERFIDE_AUTHORITY_CREDENTIAL_ID"),
    runId: required("HYPERFIDE_AUTHORITY_RUN_ID"),
    ...(env.HYPERFIDE_AUTHORITY_DEADLINE_MS ? { deadlineMs: Number(env.HYPERFIDE_AUTHORITY_DEADLINE_MS) } : {}),
  };
}

export async function createAuthorityClient(configuration: AuthorityConfiguration) {
  const config = { ...configuration };
  const url = new URL(config.url);
  const deadline = config.deadlineMs ?? 15000, max = config.maxConcurrent ?? 16;
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      config.url !== url.origin || !uuid.test(config.credentialId) || !uuid.test(config.runId) ||
      !Number.isInteger(deadline) || deadline < 100 || deadline > 120000 ||
      !Number.isInteger(max) || max < 1 || max > 128)
    throw new AuthorityError("AUTHORITY_CONFIG", "Invalid canonical HTTPS origin, scope or transport bounds");
  const st = await lstat(config.keyFile);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 65536 || (st.mode & 0o077))
    throw new AuthorityError("AUTHORITY_CONFIG", "Private key requires a bounded private regular file");
  const [ca, keyBytes] = await Promise.all([readFile(config.caFile), readFile(config.keyFile)]);
  const key = createPrivateKey(keyBytes);
  keyBytes.fill(0);
  if (key.asymmetricKeyType !== "ed25519") throw new AuthorityError("AUTHORITY_CONFIG", "Ed25519 key required");
  let active = 0;
  async function invoke<T>(action: string, input: unknown, identity?: TransactionIdentity, signal?: AbortSignal): Promise<T> {
    const operationId = identity?.operationId ?? randomUUID();
    const idempotencyKey = identity?.idempotencyKey ?? randomUUID();
    if (!uuid.test(operationId) || !uuid.test(idempotencyKey)) throw new AuthorityError("INVALID_REQUEST", "UUID operation identities required");
    const payload = Buffer.from(JSON.stringify({ run_id: config.runId, component: "platform-authority", action,
      input, expected_version: null, authority: null }));
    if (payload.length > 768 * 1024) throw new AuthorityError("REQUEST_TOO_LARGE", "Payload exceeds service limit");
    const body = Buffer.from(JSON.stringify({protocol_version: 1, operation_id: operationId,
      idempotency_key: idempotencyKey, payload_digest: digest(payload), correlation_id: operationId,
      causation_id: null, payload_b64: payload.toString("base64url")}));
    const time = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const signingBytes = Buffer.from(["HYPERFIDE-REQUEST-V1", "POST", "/v1/invoke", url.origin,
      config.credentialId, time, nonce, digest(body), ""].join("\n"));
    if (active >= max) throw new AuthorityError("ADMISSION_BUSY", "Authority concurrency limit reached");
    active++;
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const fail = (error: AuthorityError) => { if (!settled) { settled = true; reject(error); } };
        const request = https.request(new URL("/v1/invoke", url), {
          method: "POST", ca, minVersion: "TLSv1.3", rejectUnauthorized: true, agent: false,
          signal: AbortSignal.any([AbortSignal.timeout(deadline), ...(signal ? [signal] : [])]),
          headers: {"Content-Type": "application/json", "Content-Length": body.length,
            "HF-Credential-Id": config.credentialId, "HF-Request-Time": time, "HF-Request-Nonce": nonce,
            "HF-Request-Signature": sign(null, signingBytes, key).toString("base64url")},
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (part: Buffer) => {
            size += part.length;
            if (size > limit) { fail(new AuthorityError("OUTCOME_UNKNOWN", "Authority response exceeds limit", operationId)); response.destroy(); }
            else chunks.push(part);
          });
          response.once("error", () => fail(new AuthorityError("OUTCOME_UNKNOWN", "Authority response interrupted", operationId)));
          response.once("end", () => {
            if (settled) return;
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!record(value) || value.protocol_version !== 1 || typeof value.ok !== "boolean") throw Error();
              if (value.ok === false) {
                if (!record(value.error) || typeof value.error.code !== "string") throw Error();
                fail(new AuthorityError(value.error.code, `Authority rejected the operation (${value.error.code})`, operationId));
              } else {
                if (response.statusCode !== 200 || value.operation_id !== operationId || value.id !== operationId || !("result" in value)) throw Error();
                settled = true;
                resolve(value.result as T);
              }
            } catch { fail(new AuthorityError("OUTCOME_UNKNOWN", "Unverifiable authority response", operationId)); }
          });
        });
        request.once("error", () => fail(new AuthorityError("OUTCOME_UNKNOWN", "Transport interrupted; reconcile original operation identity", operationId)));
        request.end(body);
      });
    } finally { active--; }
  }
  return Object.freeze({
    pluginState: (input: PluginStateRequest, identity?: TransactionIdentity) =>
      invoke<PluginStateEntry[]>("authority.plugin-state", input, identity),
    operator: (signal?: AbortSignal) => invoke<Operator>("authority.operator", {}, undefined, signal),
    health: (signal?: AbortSignal) => invoke<{status: "ready"}>("authority.health", {}, undefined, signal),
    receipt: (id: string, signal?: AbortSignal) => invoke<Receipt | null>("authority.receipt.read", {id}, undefined, signal),
    evidence: (evidenceDigest: string, signal?: AbortSignal) => invoke<{digest: string; bytes_b64: string} | null>("authority.evidence.read", {digest: evidenceDigest}, undefined, signal),
    transaction: (writes: readonly AuthorityWrite[], identity: TransactionIdentity, signal?: AbortSignal) =>
      invoke<{committed: true; count: number}>("authority.transaction", {writes}, identity, signal),
  });
}
export type AuthorityClient = Awaited<ReturnType<typeof createAuthorityClient>>;
import type { PluginStateEntry, PluginStateRequest } from "./plugin-storage.js";
export * from "./plugin-storage.js";
