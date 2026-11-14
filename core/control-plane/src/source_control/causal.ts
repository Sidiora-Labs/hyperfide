import {
  parseGeneration,
  parseObjectId,
  parseSourceScope,
  parseStrictJSON,
  parseUUID,
  SourceControlError,
} from "./contracts.js";
import {
  sourceDigest,
  sourceScopeValues,
  SourceMetadata,
  type SourceContext,
} from "./metadata.js";
import type { PoolClient } from "pg";
import type { SourceObjectService } from "./objects.js";
import { assertSourceRecoveryAdmission } from "./recovery.js";

const unavailable = () =>
  new SourceControlError(
    "CAUSAL_UNAVAILABLE",
    "Committed source state is not currently readable",
    "RETRY_SAME_OPERATION",
    "KNOWN",
  );
/** A causal token is an opaque reference to a committed receipt, never authority. */
export async function validateSourceCausalRead(
  metadata: SourceMetadata,
  objects: SourceObjectService,
  context: SourceContext,
  action: string,
  token: string | undefined,
  callerSignal?: AbortSignal,
): Promise<void> {
  if (token === undefined) return;
  let tuple: unknown;
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error();
    tuple = parseStrictJSON(bytes, 1536);
    if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== 1)
      throw new Error();
    parseSourceScope(tuple[1]);
    parseGeneration(tuple[2]);
    parseUUID(tuple[3]);
    parseObjectId(tuple[4]);
  } catch {
    throw new SourceControlError(
      "INVALID_CAUSAL_TOKEN",
      "Malformed source causal token",
    );
  }
  const [, _scope, epoch, operation, digest] = tuple as [
    number,
    SourceContext["scope"],
    string,
    string,
    string,
  ];
  if (sourceDigest(_scope) !== sourceDigest(context.scope))
    throw new SourceControlError(
      "INVALID_CAUSAL_TOKEN",
      "Causal token belongs to another source scope",
    );
  if (epoch !== context.authority_epoch)
    throw new SourceControlError(
      "STALE_CAUSAL_TOKEN",
      "Causal token authority epoch differs",
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const verify = async () => {
    if (controller.signal.aborted) throw unavailable();
    const root = await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, action);
      if (controller.signal.aborted) throw unavailable();
      // Recovery reads ordinarily remain available; causally current reads cannot
      // use a restored snapshot until its external activation fence is satisfied.
      await assertSourceRecoveryAdmission(
        tx,
        context.scope,
        "source.causal.dependent",
        true,
      );
      const row = (
        await tx.query(
          `SELECT o.result,o.result_digest,r.root_tree_id,r.authority_epoch::text AS revision_epoch
    FROM hyperfide.source_metadata_operations o JOIN hyperfide.source_revisions r
    ON r.organisation_id=o.organisation_id AND r.repository_id=o.repository_id AND r.security_domain_id=o.security_domain_id AND r.revision_id=o.result->>'revision_id'
    WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.principal_id=$4 AND o.operation_id=$5
    AND o.action='source.revisions.create' AND o.state='COMMITTED'`,
          [
            ...sourceScopeValues(context.scope),
            context.principal_id,
            operation,
          ],
        )
      ).rows[0];
      if (!row) throw unavailable();
      const receipt = row.result,
        { causal_token, result_digest, ...body } = receipt;
      if (
        causal_token !== token ||
        result_digest !== digest ||
        row.result_digest !== digest ||
        sourceDigest(body) !== digest ||
        receipt.operation_id !== operation ||
        receipt.authority_epoch !== epoch ||
        sourceDigest(receipt.scope) !== sourceDigest(context.scope) ||
        receipt.root_tree_id !== row.root_tree_id
      )
        throw new SourceControlError(
          "INVALID_CAUSAL_TOKEN",
          "Causal token does not match its committed receipt",
        );
      return parseObjectId(row.root_tree_id);
    });
    if (controller.signal.aborted) throw unavailable();
    try {
      await objects.read(context.scope, root, controller.signal);
    } catch {
      throw unavailable();
    }
    if (controller.signal.aborted) throw unavailable();
    await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, action);
      if (controller.signal.aborted) throw unavailable();
      await assertSourceRecoveryAdmission(
        tx,
        context.scope,
        "source.causal.dependent",
        true,
      );
    });
  };
  try {
    await Promise.race([
      verify(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(unavailable()),
          { once: true },
        );
        if (controller.signal.aborted) reject(unavailable());
        timer = setTimeout(abort, 5000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}

export async function withSourceCausalRead<T>(
  metadata: SourceMetadata,
  objects: SourceObjectService,
  context: SourceContext,
  action: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  preferReplica: boolean,
  read: (metadata: SourceMetadata, route: "primary" | "replica") => Promise<T>,
): Promise<T> {
  await validateSourceCausalRead(
    metadata,
    objects,
    context,
    action,
    token,
    signal,
  );
  const replica = metadata.options.replica;
  if (!token || !preferReplica || !replica) return read(metadata, "primary");
  const wait = metadata.options.replica_wait_ms ?? 250;
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 1000)
    throw new SourceControlError(
      "CONFIGURATION_INVALID",
      "Replica observation budget must be between one and 1000 ms",
    );
  const deadline = Date.now() + wait;
  const observe = async <T>(query: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        query,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(unavailable()),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let client: PoolClient | undefined;
  let expired = false;
  try {
    const acquired = replica.connect().then((connection) => {
      if (expired) {
        connection.release();
        throw unavailable();
      }
      return connection;
    });
    client = await Promise.race([
      acquired,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(unavailable());
        }, wait);
      }),
    ]);
    clearTimeout(timer);
    timer = undefined;
    signal?.throwIfAborted();
    await observe(
      client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
    );
    await observe(
      client.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('idle_in_transaction_session_timeout','5000',true)",
        [String(Math.max(1, deadline - Date.now()))],
      ),
    );
    const tuple = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as [number, SourceContext["scope"], string, string, string];
    const row = (
      await observe(
        client.query(
          `SELECT pg_is_in_recovery() AS replica,r.authority_epoch::text,r.policy_version,o.result,o.result_digest
   FROM hyperfide.source_repositories r LEFT JOIN hyperfide.source_metadata_operations o
   ON o.organisation_id=r.organisation_id AND o.repository_id=r.repository_id AND o.security_domain_id=r.security_domain_id
   AND o.principal_id=$4 AND o.operation_id=$5 AND o.state='COMMITTED' AND o.action='source.revisions.create'
   WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3`,
          [...sourceScopeValues(context.scope), context.principal_id, tuple[3]],
        ),
      )
    ).rows[0];
    if (
      row &&
      (row.authority_epoch !== context.authority_epoch ||
        row.policy_version !== context.policy_version)
    )
      throw new SourceControlError(
        "STALE_CAUSAL_TOKEN",
        "Replica authority changed; causal receipt cannot cross epochs",
      );
    if (row?.replica !== true || !row.result || Date.now() >= deadline)
      throw unavailable();
    const { causal_token, result_digest, ...body } = row.result;
    if (
      causal_token !== token ||
      result_digest !== tuple[4] ||
      row.result_digest !== tuple[4] ||
      sourceDigest(body) !== tuple[4]
    )
      throw new SourceControlError(
        "INVALID_CAUSAL_TOKEN",
        "Replica receipt differs from the committed causal dependency",
      );
  } catch (error) {
    expired = true;
    if (timer) clearTimeout(timer);
    if (client) {
      client.release(
        error instanceof Error
          ? error
          : new Error("Replica observation failed"),
      );
      client = undefined;
    }
    if (
      error instanceof SourceControlError &&
      ["STALE_CAUSAL_TOKEN", "INVALID_CAUSAL_TOKEN"].includes(error.code)
    )
      throw error;
    signal?.throwIfAborted();
    return read(metadata, "primary");
  }
  try {
    await client.query("SELECT set_config('statement_timeout','5000',true)");
    const selected = new SourceMetadata(metadata.pool, {
      transaction: (body) => body(client!),
      read_authority: metadata,
    });
    const result = await read(selected, "replica");
    await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, action);
      await assertSourceRecoveryAdmission(
        tx,
        context.scope,
        "source.causal.dependent",
        true,
      );
    });
    return result;
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}
