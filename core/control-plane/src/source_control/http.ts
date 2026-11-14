import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { FoundationError } from "../policy/programme.js";
import { StorageError } from "../storage/transactions.js";
import {
  decodeSourceRequest,
  encodeSourceResponse,
  SOURCE_API_PATH,
  SourceControlError,
  type SourceAction,
  type SourceResponse,
  type SourceError,
} from "./contracts.js";
import {
  sourceBearerToken,
  verifySourcePrincipalToken,
  type SourceTokenTrust,
} from "./authentication.js";
import {
  sourceAdmissionClass,
  type SourceAdmissionClass,
  type createSourceApi,
} from "./api.js";
import type { SourceTransferService } from "./transfers.js";
import {
  handleSourceTransferHttp,
  isSourceTransferPath,
} from "./transfer_http.js";

export interface SourceHttpOptions {
  api: ReturnType<typeof createSourceApi>;
  transfers?: SourceTransferService;
  trust: SourceTokenTrust;
  host: string;
  port: number;
  signal: AbortSignal;
  tls?: { cert: string | Buffer; key: string | Buffer };
  allowLoopbackHTTP?: boolean;
  maxConcurrent?: number;
  admissionBudgets?: Partial<Record<SourceAdmissionClass, number>>;
  deadlineMs?: number;
}
export function sourcePublicError(error: SourceControlError): SourceError {
  const result: SourceError = {
    code: error.code,
    message: error.message,
    retry: error.retry,
    outcome: error.outcome,
  };
  if (["RESNAPSHOT_REQUIRED", "RESNAPSHOT_PENDING"].includes(error.code)) {
    const details: Record<string, string | number> = {};
    for (const key of [
      "consumer_id",
      "subscription_epoch",
      "bootstrap_revision_id",
      "authority_epoch",
      "state",
      "retention_max_events",
      "retention_expires_at",
      "retained_events",
      "boundary",
      "reason",
      "expected_previous_epoch",
    ]) {
      const value = error.details?.[key];
      if (
        (typeof value === "string" &&
          value.length <= 128 &&
          !/[\x00-\x1f\x7f]/.test(value)) ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        details[key] = value;
    }
    result.details = details;
  }
  return result;
}
export function sourceHttpStatus(error: SourceControlError): number {
  if (error.code === "UNAUTHENTICATED") return 401;
  if (error.code.includes("DENIED")) return 403;
  if (error.code.startsWith("AUTH_")) return 401;
  if (error.code.includes("NOT_FOUND")) return 404;
  if (error.code.includes("LIMIT") || error.code.includes("TOO_LARGE"))
    return 413;
  if (error.code === "OVERLOADED") return 429;
  if (error.outcome === "UNKNOWN") return 504;
  if (
    error.code.includes("UNAVAILABLE") ||
    [
      "TX_RETRY_EXHAUSTED",
      "TX_TIMEOUT",
      "MIGRATION_NOT_READY",
      "SHUTTING_DOWN",
    ].includes(error.code)
  )
    return 503;
  if (
    error.code.includes("CONFLICT") ||
    error.code.includes("CHANGED") ||
    error.code.includes("STALE")
  )
    return 409;
  if (error.code === "INTERNAL_ERROR") return 500;
  return 400;
}
export function sourceHttpError(error: unknown): SourceControlError {
  return error instanceof SourceControlError
    ? error
    : error instanceof StorageError
      ? new SourceControlError(
          error.code,
          error.message,
          error.outcome === "unknown" || error.retryable
            ? "RETRY_SAME_OPERATION"
            : "NEVER",
          error.outcome === "unknown" ? "UNKNOWN" : "KNOWN",
        )
      : error instanceof FoundationError
        ? error.code === "OUTCOME_UNKNOWN"
          ? new SourceControlError(
              error.code,
              error.message,
              "RETRY_SAME_OPERATION",
              "UNKNOWN",
            )
          : error.code === "HANDLER_FAILED"
            ? new SourceControlError(
                "INTERNAL_ERROR",
                "Source operation failed",
              )
            : new SourceControlError(error.code, error.message)
        : new SourceControlError("INTERNAL_ERROR", "Source operation failed");
}
export function writeSourceHttpResponse(
  response: ServerResponse,
  value: SourceResponse,
  action: SourceAction | undefined,
  status: number,
): void {
  if (response.destroyed || response.writableEnded) return;
  let bytes: Uint8Array;
  try {
    bytes = encodeSourceResponse(value, action ? { action } : {});
  } catch (error) {
    const excessive =
      error instanceof SourceControlError && error.code === "LIMIT_EXCEEDED";
    const failure = new SourceControlError(
      excessive ? "LIMIT_EXCEEDED" : "INTERNAL_ERROR",
      excessive
        ? "Source response exceeds its wire limit"
        : "Source response is invalid",
      excessive ? "RESUME" : "NEVER",
      excessive ? "UNKNOWN" : "KNOWN",
    );
    status = sourceHttpStatus(failure);
    bytes = encodeSourceResponse({
      protocol_version: 1,
      operation_id: value.operation_id,
      error: {
        code: failure.code,
        message: failure.message,
        retry: failure.retry,
        outcome: failure.outcome,
      },
    });
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}
export async function startSourceHttp(
  options: SourceHttpOptions,
): Promise<{ address: string; close(): Promise<void> }> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    !options.host ||
    (!options.tls &&
      !(
        options.allowLoopbackHTTP && ["127.0.0.1", "::1"].includes(options.host)
      ))
  )
    throw new SourceControlError(
      "CONFIGURATION_INVALID",
      "TLS is required outside explicitly enabled loopback HTTP",
    );
  const maximum = options.maxConcurrent ?? 32,
    deadline = options.deadlineMs ?? 30000;
  if (
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 512 ||
    !Number.isInteger(deadline) ||
    deadline < 100 ||
    deadline > 120000
  )
    throw new SourceControlError(
      "CONFIGURATION_INVALID",
      "Invalid source listener admission policy",
    );
  const classes: SourceAdmissionClass[] = [
    "upload",
    "query",
    "event",
    "acceptance",
    "mutation",
  ];
  const budgets = Object.fromEntries(
    classes.map((kind) => [kind, options.admissionBudgets?.[kind] ?? maximum]),
  ) as Record<SourceAdmissionClass, number>;
  if (
    Object.keys(options.admissionBudgets ?? {}).some(
      (kind) => !classes.includes(kind as SourceAdmissionClass),
    ) ||
    classes.some(
      (kind) =>
        !Number.isInteger(budgets[kind]) ||
        budgets[kind] < 1 ||
        budgets[kind] > 512,
    )
  )
    throw new SourceControlError(
      "CONFIGURATION_INVALID",
      "Each source admission class requires a bounded positive budget",
    );
  const active: Record<SourceAdmissionClass, number> = {
    upload: 0,
    query: 0,
    event: 0,
    acceptance: 0,
    mutation: 0,
  };
  let accepting = true;
  const pending = new Set<Promise<void>>();
  const write = writeSourceHttpResponse;
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let operation: string = randomUUID(),
      action: SourceAction | undefined,
      admitted: SourceAdmissionClass | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const sendError = (error: SourceControlError) =>
      write(
        response,
        {
          protocol_version: 1,
          operation_id: operation,
          error: sourcePublicError(error),
        },
        action,
        sourceHttpStatus(error),
      );
    if (!accepting) {
      sendError(
        new SourceControlError(
          "SERVICE_UNAVAILABLE",
          "Source service is stopping",
        ),
      );
      return;
    }
    const admit = (kind: SourceAdmissionClass) => {
      if (active[kind] >= budgets[kind])
        throw new SourceControlError(
          "OVERLOADED",
          "Source " + kind + " request budget is exhausted",
          "RESUME",
        );
      active[kind]++;
      admitted = kind;
    };
    const controller = new AbortController(),
      abort = () => controller.abort(),
      disconnected = () => {
        if (!response.writableEnded) abort();
      };
    options.signal.addEventListener("abort", abort, { once: true });
    request.once("aborted", abort);
    response.once("close", disconnected);
    try {
      timer = setTimeout(() => {
        abort();
        sendError(
          new SourceControlError(
            "OUTCOME_UNKNOWN",
            "Request deadline elapsed; resolve the original operation",
            "RETRY_SAME_OPERATION",
            "UNKNOWN",
          ),
        );
        request.destroy();
      }, deadline);
      if (isSourceTransferPath(request.url)) admit("upload");
      if (
        await handleSourceTransferHttp(
          options.transfers,
          request,
          response,
          controller.signal,
        )
      )
        return;
      if (
        request.method !== "POST" ||
        request.url !== SOURCE_API_PATH ||
        request.headers["content-encoding"] !== undefined ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers["content-type"] ?? "",
        )
      )
        throw new SourceControlError(
          "INVALID_REQUEST",
          "Versioned JSON POST endpoint required",
        );
      const token = sourceBearerToken(request.headers.authorization);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 12 * 1024 * 1024)
          throw new SourceControlError(
            "LIMIT_EXCEEDED",
            "Source request exceeds its wire limit",
          );
        chunks.push(bytes);
      }
      const decoded = decodeSourceRequest(Buffer.concat(chunks));
      operation = decoded.operation_id;
      action = decoded.action;
      const principal = verifySourcePrincipalToken(
        token,
        options.trust,
        decoded.scope,
      );
      admit(sourceAdmissionClass(decoded.action));
      const result = await options.api.invoke(action, decoded, {
        ...principal,
        signal: controller.signal,
      });
      write(
        response,
        { protocol_version: 1, operation_id: operation, result },
        action,
        200,
      );
    } catch (error) {
      const underlying = error instanceof Error ? error : undefined;
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      console.error(
        JSON.stringify({
          event: "source_request_failed",
          action: action ?? null,
          operation_id: operation,
          name: underlying?.name ?? typeof error,
          message: underlying?.message ?? String(error),
          code:
            typeof code === "string" || typeof code === "number" ? code : null,
          stack: underlying?.stack ?? null,
        }),
      );
      sendError(sourceHttpError(error));
    } finally {
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      request.removeListener("aborted", abort);
      response.removeListener("close", disconnected);
      if (admitted) active[admitted]--;
    }
  }
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    let run: Promise<void>;
    run = handle(request, response).finally(() => pending.delete(run));
    pending.add(run);
    void run.catch(() => response.destroy());
  };
  const server = options.tls
    ? https.createServer(
        { ...options.tls, minVersion: "TLSv1.3", maxHeaderSize: 16384 },
        listener,
      )
    : http.createServer({ maxHeaderSize: 16384 }, listener);
  server.maxHeadersCount = 32;
  server.maxConnections =
    classes.reduce((sum, kind) => sum + budgets[kind], 0) * 4;
  server.requestTimeout = deadline;
  server.headersTimeout = Math.min(deadline, 10000);
  server.keepAliveTimeout = 3000;
  server.on("clientError", (_error, socket) => socket.destroy());
  if (options.signal.aborted)
    throw new SourceControlError(
      "SERVICE_UNAVAILABLE",
      "Source startup was cancelled",
    );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new SourceControlError(
      "CONFIGURATION_INVALID",
      "Expected a TCP source listener",
    );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      accepting = false;
      options.signal.removeEventListener("abort", abort);
      const ended = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      const timeout = setTimeout(() => server.closeAllConnections(), deadline);
      try {
        await ended;
        await Promise.allSettled([...pending]);
      } finally {
        clearTimeout(timeout);
      }
    })());
  const abort = () => {
    void close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) await close();
  return {
    address: `${options.tls ? "https" : "http"}://${address.family === "IPv6" ? "[" + address.address + "]" : address.address}:${address.port}`,
    close,
  };
}
