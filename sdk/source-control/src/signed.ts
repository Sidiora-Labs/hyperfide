import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { createSecureContext } from "node:tls";
import {
  SourceControlClient,
  SourceControlError,
  SOURCE_API_PATH,
  parseSourceScope,
  parseUUID,
  type SourceScope,
} from "./index.js";

export interface SignedSourceConfiguration {
  schema_version: 1;
  endpoint: string;
  scope: SourceScope;
  credential_id: string;
  ca_file: string;
  key_file: string;
}
function invalid(): never {
  throw new SourceControlError(
    "CONFIGURATION_INVALID",
    "Signed source transport requires a canonical endpoint, scoped credential and protected TLS/key files",
  );
}
async function readTransportFile(
  filename: string,
  privateKey: boolean,
  maximum: number,
): Promise<Buffer> {
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    /[\x00-\x1f\x7f]/.test(filename)
  )
    invalid();
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximum ||
      before.nlink !== 1 ||
      (privateKey &&
        ((before.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            before.uid !== process.getuid()))) ||
      (!privateKey && (before.mode & 0o022) !== 0)
    )
      invalid();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    const bytes = buffer.subarray(0, length),
      after = await file.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      bytes.fill(0);
      invalid();
    }
    return bytes;
  } catch (error) {
    if (error instanceof SourceControlError) throw error;
    return invalid();
  } finally {
    await file?.close();
  }
}

export async function createSignedSourceClient(
  configuration: SignedSourceConfiguration,
): Promise<SourceControlClient> {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration) ||
    configuration.schema_version !== 1 ||
    Object.keys(configuration).some(
      (key) =>
        ![
          "schema_version",
          "endpoint",
          "scope",
          "credential_id",
          "ca_file",
          "key_file",
        ].includes(key),
    )
  )
    invalid();
  let endpoint: URL;
  try {
    endpoint = new URL(configuration.endpoint);
  } catch {
    return invalid();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    configuration.endpoint !== endpoint.origin + SOURCE_API_PATH
  )
    invalid();
  const scope = parseSourceScope(configuration.scope),
    credential = parseUUID(configuration.credential_id, "credential_id");
  const ca = await readTransportFile(configuration.ca_file, false, 1048576);
  const keyBytes = await readTransportFile(configuration.key_file, true, 65536);
  let key;
  try {
    key = createPrivateKey(keyBytes);
    if (key.asymmetricKeyType !== "ed25519") invalid();
    createSecureContext({ ca, minVersion: "TLSv1.3" });
  } catch {
    return invalid();
  } finally {
    keyBytes.fill(0);
  }
  const endpointText = endpoint.toString();
  const transport: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      url !== endpointText ||
      init?.method !== "POST" ||
      !(init.body instanceof Uint8Array) ||
      init.body.byteLength > 12 * 1024 * 1024
    )
      invalid();
    const body = init.body,
      headers = new Headers(init.headers);
    headers.set("content-length", String(body.byteLength));
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(
        endpoint,
        {
          method: "POST",
          ca,
          minVersion: "TLSv1.3",
          rejectUnauthorized: true,
          agent: false,
          ...(init.signal ? { signal: init.signal } : {}),
          headers: Object.fromEntries(headers.entries()),
        },
        (incoming) => {
          try {
            const responseHeaders = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              responseHeaders.append(
                incoming.rawHeaders[index]!,
                incoming.rawHeaders[index + 1]!,
              );
            const stream = Readable.toWeb(
              incoming,
            ) as ReadableStream<Uint8Array>;
            resolve(
              new Response(stream, {
                status: incoming.statusCode ?? 502,
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      request.once("error", reject);
      request.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    });
  };
  return new SourceControlClient({
    endpoint: endpointText,
    scope,
    fetch: transport,
    authenticate: ({ endpoint: actual, method, body }) => {
      if (actual !== endpointText || method !== "POST") invalid();
      const time = String(Math.floor(Date.now() / 1000)),
        nonce = randomUUID();
      const digest =
        "sha256:" + createHash("sha256").update(body).digest("hex");
      const payload = Buffer.from(
        [
          "HYPERFIDE-REQUEST-V1",
          "POST",
          SOURCE_API_PATH,
          endpoint.origin,
          credential,
          time,
          nonce,
          digest,
          "",
        ].join("\n"),
      );
      return {
        "HF-Credential-Id": credential,
        "HF-Request-Time": time,
        "HF-Request-Nonce": nonce,
        "HF-Request-Signature": sign(null, payload, key).toString("base64url"),
      };
    },
  });
}
