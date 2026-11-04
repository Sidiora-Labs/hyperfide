import { randomUUID } from "node:crypto";
import { parseObjectId, parseUUID, SourceControlError } from "./contracts.js";
import type { SourceContext, SourceMetadata, SourceSQL } from "./metadata.js";
import { sourceFailure, sourceScopeValues } from "./metadata.js";

export interface SourceSubscriptionInput {
  consumer_id: string;
  bootstrap_revision_id: string;
  retention_max_events?: number;
  retention_expires_at?: string;
  expected_previous_epoch?: string;
}
export interface SourceSubscription {
  consumer_id: string;
  subscription_epoch: string;
  bootstrap_revision_id: string;
  state: "ACTIVE" | "RESNAPSHOT_REQUIRED";
  authority_epoch: string;
  retention_max_events: number;
  retention_expires_at: string;
  retained_events: number;
  boundary: "REGISTERED" | "RESNAPSHOT";
}
export interface SourceEventDelivery {
  event_id: string;
  aggregate_id: string;
  aggregate_generation: string;
  event_type: string;
  payload: unknown;
  lease_id: string;
  lease_expires_at: string;
  attempts: number;
}
export interface SourceAcknowledgment {
  consumer_id: string;
  subscription_epoch: string;
  event_id: string;
  lease_id: string;
}
const subscriptionView = (row: any): SourceSubscription => ({
  consumer_id: row.consumer_id,
  subscription_epoch: row.subscription_epoch,
  bootstrap_revision_id: row.bootstrap_revision_id,
  state: row.state,
  authority_epoch: String(row.authority_epoch),
  retention_max_events: row.retention_max_events,
  retention_expires_at: new Date(row.retention_expires_at).toISOString(),
  retained_events: row.retained_events,
  boundary: row.boundary,
});
function resnapshot(row: any): never {
  throw new SourceControlError(
    "RESNAPSHOT_REQUIRED",
    "Subscription retention ended; read an explicit immutable bootstrap and create a new boundary",
    "NEVER",
    "KNOWN",
    { ...subscriptionView(row), reason: row.resnapshot_reason },
  );
}
export async function createSourceSubscription(
  store: SourceMetadata,
  context: SourceContext,
  input: SourceSubscriptionInput,
): Promise<SourceSubscription> {
  parseUUID(input.consumer_id, "consumer_id");
  parseObjectId(input.bootstrap_revision_id);
  if (input.expected_previous_epoch !== undefined)
    parseUUID(input.expected_previous_epoch, "expected_previous_epoch");
  const maximum = input.retention_max_events ?? 10000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100000)
    sourceFailure(
      "LIMIT_EXCEEDED",
      "Subscription event retention must be between one and 100000",
    );
  if (
    input.retention_expires_at !== undefined &&
    (!Number.isFinite(Date.parse(input.retention_expires_at)) ||
      new Date(input.retention_expires_at).toISOString() !==
        input.retention_expires_at)
  )
    sourceFailure(
      "INVALID_REQUEST",
      "Subscription retention deadline must be canonical UTC",
    );
  const outcome = await store.transaction(async (tx) => {
    await store.guard(tx, context, "source.subscriptions.create", true);
    const values = [...sourceScopeValues(context.scope), input.consumer_id];
    const old = (
      await tx.query(
        "SELECT * FROM hyperfide.source_event_consumers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 FOR UPDATE",
        values,
      )
    ).rows[0];
    if (old && old.principal_id !== context.principal_id)
      sourceFailure("CONFLICT", "Subscription belongs to another principal");
    const same =
      old &&
      old.bootstrap_revision_id === input.bootstrap_revision_id &&
      old.retention_max_events === maximum &&
      (input.retention_expires_at === undefined ||
        new Date(old.retention_expires_at).toISOString() ===
          input.retention_expires_at);
    if (
      old &&
      String(old.authority_epoch) !== context.authority_epoch &&
      input.expected_previous_epoch === undefined
    )
      sourceFailure(
        "STALE_SUBSCRIPTION",
        "Subscription belongs to an earlier source authority epoch",
      );
    if (old && input.expected_previous_epoch === undefined) {
      if (!same)
        sourceFailure(
          "CONFLICT",
          "Subscription is bound to another bootstrap or retention policy",
        );
      return { subscription: subscriptionView(old) };
    }
    if (
      old &&
      input.expected_previous_epoch === old.previous_subscription_epoch
    ) {
      if (!same)
        sourceFailure(
          "CONFLICT",
          "Resnapshot replay changed its bootstrap or retention policy",
        );
      return { subscription: subscriptionView(old) };
    }
    if (
      input.expected_previous_epoch !== undefined &&
      (!old || old.subscription_epoch !== input.expected_previous_epoch)
    )
      sourceFailure(
        "STALE_SUBSCRIPTION",
        "Resnapshot expected a different subscription epoch",
      );
    const times = (
      await tx.query(
        "SELECT clock_timestamp() AS now,COALESCE($1::timestamptz,clock_timestamp()+interval '24 hours') AS deadline",
        [input.retention_expires_at ?? null],
      )
    ).rows[0]!;
    const deadline = new Date(times.deadline),
      now = new Date(times.now);
    if (
      deadline.getTime() <= now.getTime() ||
      deadline.getTime() > now.getTime() + 7 * 86400000
    )
      sourceFailure(
        "LIMIT_EXCEEDED",
        "Subscription retention deadline must be in the next seven days",
      );
    const revision = (
      await tx.query(
        "SELECT revision_id FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4",
        [...sourceScopeValues(context.scope), input.bootstrap_revision_id],
      )
    ).rows[0];
    if (!revision)
      sourceFailure(
        "NOT_FOUND",
        "Subscription requires a retained immutable bootstrap revision",
      );
    if (old) {
      await tx.query("UPDATE hyperfide.source_event_consumers SET state='RESNAPSHOT_REQUIRED',resnapshot_reason=COALESCE(resnapshot_reason,'EVENT_BUDGET') WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4",values);
      const pending = (
        await tx.query(
          "SELECT event_id FROM hyperfide.source_event_deliveries WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 ORDER BY event_id LIMIT 4096",
          values,
        )
      ).rows.map((row) => row.event_id);
      if (pending.length) {
        await tx.query(
          "DELETE FROM hyperfide.source_event_inbox WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=ANY($5::uuid[])",
          [...values, pending],
        );
        await tx.query(
          "DELETE FROM hyperfide.source_event_deliveries WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=ANY($5::uuid[])",
          [...values, pending],
        );
      }
      const more =
        (
          await tx.query(
            "SELECT 1 FROM hyperfide.source_event_deliveries WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 LIMIT 1",
            values,
          )
        ).rows.length > 0;
      if (more) {
        await tx.query(
          "UPDATE hyperfide.source_event_consumers SET state='RESNAPSHOT_REQUIRED',resnapshot_reason=COALESCE(resnapshot_reason,'EVENT_BUDGET'),retained_events=GREATEST(0,retained_events-$5) WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4",
          [...values, pending.length],
        );
        return { pending: true };
      }
      const row = (
        await tx.query(
          "UPDATE hyperfide.source_event_consumers SET subscription_epoch=$5,previous_subscription_epoch=$6,bootstrap_revision_id=$7,backfill_high_id=NULL,backfill_after_id=NULL,backfill_complete=true,state='ACTIVE',retention_max_events=$8,retention_expires_at=$9,retained_events=0,resnapshot_reason=NULL,boundary='RESNAPSHOT',snapshot_boundary=pg_current_snapshot(),authority_epoch=$10 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 RETURNING *",
          [
            ...values,
            randomUUID(),
            old.subscription_epoch,
            input.bootstrap_revision_id,
            maximum,
            deadline,
            context.authority_epoch,
          ],
        )
      ).rows[0]!;
      return { subscription: subscriptionView(row) };
    }
    const high =
      (
        await tx.query(
          "SELECT event_id FROM hyperfide.source_events WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY event_id DESC LIMIT 1",
          sourceScopeValues(context.scope),
        )
      ).rows[0]?.event_id ?? null;
    const row = (
      await tx.query(
        "INSERT INTO hyperfide.source_event_consumers(organisation_id,repository_id,security_domain_id,consumer_id,principal_id,subscription_epoch,bootstrap_revision_id,backfill_high_id,backfill_complete,retention_max_events,retention_expires_at,authority_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [
          ...values,
          context.principal_id,
          randomUUID(),
          input.bootstrap_revision_id,
          high,
          high === null,
          maximum,
          deadline,
          context.authority_epoch,
        ],
      )
    ).rows[0]!;
    return { subscription: subscriptionView(row) };
  });
  if ("pending" in outcome)
    throw new SourceControlError(
      "RESNAPSHOT_PENDING",
      "Old delivery cleanup made bounded progress; retry the same expected epoch",
      "RETRY_SAME_OPERATION",
      "KNOWN",
      {
        consumer_id: input.consumer_id,
        expected_previous_epoch: input.expected_previous_epoch,
      },
    );
  return outcome.subscription;
}
async function consumer(
  tx: SourceSQL,
  context: SourceContext,
  consumerId: string,
  epoch: string,
) {
  parseUUID(consumerId, "consumer_id");
  parseUUID(epoch, "subscription_epoch");
  const row = (
    await tx.query(
      "SELECT *,retention_expires_at>clock_timestamp() AS retention_current FROM hyperfide.source_event_consumers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND principal_id=$5 AND subscription_epoch=$6 FOR NO KEY UPDATE",
      [
        ...sourceScopeValues(context.scope),
        consumerId,
        context.principal_id,
        epoch,
      ],
    )
  ).rows[0];
  if (!row)
    sourceFailure(
      "STALE_SUBSCRIPTION",
      "Subscription is unavailable for this principal, scope or epoch",
    );
  if (String(row.authority_epoch) !== context.authority_epoch)
    sourceFailure(
      "STALE_SUBSCRIPTION",
      "Subscription belongs to an earlier source authority epoch",
    );
  return row;
}
export async function pollSourceEvents(
  store: SourceMetadata,
  context: SourceContext,
  input: {
    consumer_id: string;
    subscription_epoch: string;
    limit?: number;
    lease_ms?: number;
  },
): Promise<{ deliveries: SourceEventDelivery[]; backfill_complete: boolean }> {
  const limit = input.limit ?? 100,
    leaseMs = input.lease_ms ?? 30000;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256 ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 120000
  )
    sourceFailure(
      "INVALID_REQUEST",
      "Bounded event page and delivery lease required",
    );
  const outcome = await store.transaction(async (tx) => {
    await store.guard(tx, context, "source.subscriptions.poll");
    const row = await consumer(
        tx,
        context,
        input.consumer_id,
        input.subscription_epoch,
      ),
      scope = sourceScopeValues(context.scope);
    if (row.state !== "ACTIVE" || row.retention_current !== true) {
      const expired = (
        await tx.query(
          "UPDATE hyperfide.source_event_consumers SET state='RESNAPSHOT_REQUIRED',resnapshot_reason=COALESCE(resnapshot_reason,'RETENTION_EXPIRED') WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 RETURNING *",
          [...scope, input.consumer_id],
        )
      ).rows[0];
      return { resnapshot: expired };
    }
    const capacity = row.retention_max_events - row.retained_events;
    const pageLimit = Math.min(256, Math.max(0, capacity));
    const page = (
      await tx.query(
        `SELECT e.event_id FROM hyperfide.source_events e
      WHERE e.organisation_id=$1 AND e.repository_id=$2 AND e.security_domain_id=$3
      AND ($5::pg_snapshot IS NULL OR e.creator_xid>=pg_snapshot_xmax($5::pg_snapshot) OR e.creator_xid IN(SELECT pg_snapshot_xip($5::pg_snapshot)))
      AND NOT EXISTS(SELECT 1 FROM hyperfide.source_event_deliveries d WHERE d.organisation_id=e.organisation_id AND d.repository_id=e.repository_id AND d.security_domain_id=e.security_domain_id AND d.consumer_id=$4 AND d.event_id=e.event_id)
      ORDER BY e.creator_xid,e.event_id LIMIT $6`,
        [...scope, input.consumer_id, row.snapshot_boundary, pageLimit + 1],
      )
    ).rows;
    if (page.length > capacity) {
      const expired = (
        await tx.query(
          "UPDATE hyperfide.source_event_consumers SET state='RESNAPSHOT_REQUIRED',resnapshot_reason='EVENT_BUDGET' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 RETURNING *",
          [...scope, input.consumer_id],
        )
      ).rows[0];
      return { resnapshot: expired };
    }
    const selected = page.slice(0, pageLimit);
    let inserted = 0;
    if (selected.length)
      inserted = (
        await tx.query(
          "INSERT INTO hyperfide.source_event_deliveries(organisation_id,repository_id,security_domain_id,consumer_id,event_id,state) SELECT $1,$2,$3,$4,event_id,'PENDING' FROM unnest($5::uuid[]) AS e(event_id) ON CONFLICT DO NOTHING RETURNING event_id",
          [
            ...scope,
            input.consumer_id,
            selected.map((value) => value.event_id),
          ],
        )
      ).rows.length;
    const complete = page.length <= pageLimit;
    await tx.query(
      "UPDATE hyperfide.source_event_consumers SET backfill_complete=$5,retained_events=retained_events+$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4",
      [...scope, input.consumer_id, complete, inserted],
    );
    const leaseId = randomUUID();
    const deliveries = (
      await tx.query(
        `WITH selected AS (
   SELECT event_id FROM hyperfide.source_event_deliveries WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4
   AND (state='PENDING' OR state='LEASED' AND lease_expires_at<=clock_timestamp()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT $5
  ), leased AS (
   UPDATE hyperfide.source_event_deliveries d SET state='LEASED',lease_id=$6,lease_expires_at=clock_timestamp()+$7::bigint*interval '1 millisecond',attempts=d.attempts+1
   FROM selected s WHERE d.organisation_id=$1 AND d.repository_id=$2 AND d.security_domain_id=$3 AND d.consumer_id=$4 AND d.event_id=s.event_id RETURNING d.*
  ) SELECT e.event_id,e.aggregate_id,e.aggregate_generation::text,e.event_type,e.payload,l.lease_id,l.lease_expires_at,l.attempts
  FROM leased l JOIN hyperfide.source_events e USING(organisation_id,repository_id,security_domain_id,event_id) ORDER BY e.event_id`,
        [...scope, input.consumer_id, limit, leaseId, leaseMs],
      )
    ).rows;
    return {
      deliveries: deliveries.map(
        (r) =>
          ({
            ...r,
            lease_expires_at: new Date(r.lease_expires_at).toISOString(),
          }) as SourceEventDelivery,
      ),
      backfill_complete: complete,
    };
  });
  if ("resnapshot" in outcome) resnapshot(outcome.resnapshot);
  return outcome;
}
export async function applySourceEvent<T>(
  store: SourceMetadata,
  context: SourceContext,
  input: SourceAcknowledgment,
  apply: (tx: SourceSQL, payload: unknown) => Promise<T>,
): Promise<{ duplicate: boolean; result: T }> {
  parseUUID(input.event_id, "event_id");
  parseUUID(input.lease_id, "lease_id");
  return store.transaction(async (tx) => {
    await store.guard(tx, context, "source.subscriptions.ack");
    const current = await consumer(
      tx,
      context,
      input.consumer_id,
      input.subscription_epoch,
    );
    if (current.state !== "ACTIVE" || current.retention_current !== true)
      resnapshot(current);
    const values = [
      ...sourceScopeValues(context.scope),
      input.consumer_id,
      input.event_id,
    ];
    const row = (
      await tx.query(
        "SELECT d.*,e.payload,d.lease_expires_at>clock_timestamp() AS lease_valid FROM hyperfide.source_event_deliveries d JOIN hyperfide.source_events e USING(organisation_id,repository_id,security_domain_id,event_id) WHERE d.organisation_id=$1 AND d.repository_id=$2 AND d.security_domain_id=$3 AND d.consumer_id=$4 AND d.event_id=$5 FOR UPDATE OF d",
        values,
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "NOT_FOUND",
        "Delivery is unavailable in the authorized subscription",
      );
    if (row.state === "ACKNOWLEDGED") {
      if (row.acknowledged_lease_id !== input.lease_id)
        sourceFailure(
          "STALE_LEASE",
          "Acknowledgment belongs to another delivery lease",
        );
      const inbox = (
        await tx.query(
          "SELECT result FROM hyperfide.source_event_inbox WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=$5",
          values,
        )
      ).rows[0];
      if (!inbox)
        sourceFailure(
          "CONFLICT",
          "Acknowledged delivery has no transactional inbox result",
        );
      return { duplicate: true, result: inbox.result as T };
    }
    if (
      row.state !== "LEASED" ||
      row.lease_id !== input.lease_id ||
      row.lease_valid !== true
    )
      sourceFailure("STALE_LEASE", "Delivery lease expired or was reassigned");
    const result = await apply(tx, row.payload);
    await tx.query(
      "INSERT INTO hyperfide.source_event_inbox(organisation_id,repository_id,security_domain_id,consumer_id,event_id,result) VALUES($1,$2,$3,$4,$5,$6)",
      [...values, JSON.stringify(result ?? null)],
    );
    await tx.query(
      "UPDATE hyperfide.source_event_deliveries SET state='ACKNOWLEDGED',acknowledged_at=clock_timestamp(),acknowledged_lease_id=$6,lease_id=NULL,lease_expires_at=NULL WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=$5",
      [...values, input.lease_id],
    );
    return { duplicate: false, result };
  });
}
export async function acknowledgeSourceEvent(
  store: SourceMetadata,
  context: SourceContext,
  input: SourceAcknowledgment,
) {
  return applySourceEvent(store, context, input, async () => null);
}
