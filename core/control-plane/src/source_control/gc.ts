import { releaseTerminalEvidence } from "./evidence.js";
import { randomUUID } from "node:crypto";
import {
  parseGeneration,
  parseObjectId,
  parseUUID,
  SourceControlError,
} from "./contracts.js";
import { validateStorageScope } from "./object_catalog.js";
import { retentionScope } from "./pins.js";
import type {
  SourceCatalogDatabase,
  SourceDeletionBackend,
  SourceStorageScope,
  SourceTransaction,
} from "./storage_contract.js";
export interface SourceRetentionPolicy {
  expected_generation: string;
  minimum_age_seconds: number;
  quarantine_seconds: number;
  backup_until: string;
  backend_identity: string;
  independent_expiration: boolean;
}
export type SourceCollectionDebt =
  | {
      kind: "COLLECTION";
      object_id: string;
      incarnation_id: string;
      generation: string;
      operation_id: string;
      state: "QUARANTINED" | "DELETE_PENDING";
      attempts: number;
      last_outcome: "UNKNOWN" | "PIN_ACQUIRED" | null;
      eligible_at: string;
    }
  | {
      kind: "CHILD_RESERVATION";
      debt_kind: "PARENT_OUTCOME_UNKNOWN";
      object_id: string;
      incarnation_id: string;
      operation_id: string;
      reservation_id: string;
      parent_object_id: string;
      parent_incarnation_id: string;
      child_object_id: string;
      child_incarnation_id: string;
      position: number;
      state: "RESERVED";
    };
async function backupRetains(
  tx: SourceTransaction,
  scope: SourceStorageScope,
  objectId: string,
  incarnationId: string,
): Promise<boolean> {
  return Boolean(
    (
      await tx.query(
        `SELECT 1 FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND owner_kind='BACKUP' AND state='ACTIVE' AND (expires_at IS NULL OR expires_at>clock_timestamp()) UNION ALL SELECT 1 FROM hyperfide.source_backup_objects o JOIN hyperfide.source_backups b USING(organisation_id,repository_id,security_domain_id,backup_id) WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=$4 AND o.incarnation_id=$5 AND b.expires_at>clock_timestamp() LIMIT 1`,
        [...retentionScope(scope), objectId, incarnationId],
      )
    ).rowCount,
  );
}
const bounded = (value: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Collection limit is out of bounds",
    );
};
export class SourceCollector {
  constructor(
    private readonly database: SourceCatalogDatabase,
    private readonly backend: SourceDeletionBackend,
  ) {}
  async configure(scope: SourceStorageScope, input: SourceRetentionPolicy) {
    validateStorageScope(scope);
    parseGeneration(input.expected_generation);
    bounded(input.minimum_age_seconds, 31536000);
    bounded(input.quarantine_seconds, 31536000);
    if (
      !Number.isFinite(Date.parse(input.backup_until)) ||
      input.independent_expiration !== false ||
      input.backend_identity !== this.backend.identity
    )
      throw new SourceControlError(
        "RETENTION_POLICY_INVALID",
        "Retention requires exact backend identity and no independent expiration",
      );
    if (typeof this.backend.lifecycleConfiguration !== "function")
      throw new SourceControlError(
        "RETENTION_POLICY_INVALID",
        "Backend lifecycle inspection is required",
      );
    const lifecycle = await this.backend.lifecycleConfiguration();
    if (
      lifecycle.rules.some(
        (rule) =>
          rule.enabled &&
          (rule.expiration || rule.noncurrent_version_expiration) &&
          ("source/v1/".startsWith(rule.prefix) ||
            rule.prefix.startsWith("source/v1/")),
      )
    )
      throw new SourceControlError(
        "RETENTION_POLICY_INVALID",
        "Bucket lifecycle independently expires native source placements",
      );
    return this.database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        retentionScope(scope).join("/"),
      ]);
      const row = (
        await tx.query(
          "SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR UPDATE",
          retentionScope(scope),
        )
      ).rows[0];
      if (
        row &&
        row.generation === String(BigInt(input.expected_generation) + 1n) &&
        row.minimum_age_seconds === input.minimum_age_seconds &&
        row.quarantine_seconds === input.quarantine_seconds &&
        new Date(row.backup_until).getTime() ===
          Date.parse(input.backup_until) &&
        row.backend_identity === input.backend_identity
      )
        return { generation: row.generation };
      if ((row?.generation ?? "0") !== input.expected_generation)
        throw new SourceControlError(
          "STALE_GENERATION",
          "Retention policy generation changed",
        );
      if (
        (
          await tx.query(
            "SELECT 1 FROM hyperfide.source_collection_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND state='DELETE_PENDING' LIMIT 1",
            retentionScope(scope),
          )
        ).rowCount
      )
        throw new SourceControlError(
          "COLLECTION_IN_PROGRESS",
          "Resolve admitted deletions before changing retention policy",
        );
      const generation = String(BigInt(input.expected_generation) + 1n);
      await tx.query(
        `INSERT INTO hyperfide.source_retention_policies(organisation_id,repository_id,security_domain_id,generation,minimum_age_seconds,quarantine_seconds,backup_until,backend_identity,independent_expiration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(organisation_id,repository_id,security_domain_id) DO UPDATE SET generation=EXCLUDED.generation,minimum_age_seconds=EXCLUDED.minimum_age_seconds,quarantine_seconds=EXCLUDED.quarantine_seconds,backup_until=EXCLUDED.backup_until,backend_identity=EXCLUDED.backend_identity`,
        [
          ...retentionScope(scope),
          generation,
          input.minimum_age_seconds,
          input.quarantine_seconds,
          input.backup_until,
          input.backend_identity,
        ],
      );
      return { generation };
    });
  }
  async discover(
    scope: SourceStorageScope,
    input: { partition: number; limit: number },
  ) {
    validateStorageScope(scope);
    bounded(input.partition, 15);
    bounded(input.limit, 256);
    if (!input.limit)
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Positive collection limit required",
      );
    return this.database.transaction(async (tx) => {
      const policy = (
        await tx.query(
          "SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE",
          retentionScope(scope),
        )
      ).rows[0];
      if (!policy)
        return {
          quarantined: [],
          blocked: "RETENTION_POLICY_REQUIRED",
        };
      if (
        policy.backend_identity !== this.backend.identity ||
        policy.independent_expiration
      )
        throw new SourceControlError(
          "RETENTION_POLICY_INVALID",
          "Backend retention policy changed",
        );
      await releaseTerminalEvidence(tx, scope, input.partition, input.limit);
      const rows = (
        await tx.query(
          `SELECT o.*,o.generation::text,p.storage_key FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.gc_partition=$4 AND o.state IN ('VERIFIED','UPLOADING') AND o.created_at<=clock_timestamp()-($5::integer*interval '1 second') AND NOT EXISTS(SELECT 1 FROM hyperfide.source_object_pins pin WHERE pin.organisation_id=o.organisation_id AND pin.repository_id=o.repository_id AND pin.security_domain_id=o.security_domain_id AND pin.object_id=o.object_id AND pin.incarnation_id=o.current_incarnation AND (pin.expires_at IS NULL OR pin.expires_at>clock_timestamp())) AND NOT EXISTS(SELECT 1 FROM hyperfide.source_backup_objects captured JOIN hyperfide.source_backups backup USING(organisation_id,repository_id,security_domain_id,backup_id) WHERE captured.organisation_id=o.organisation_id AND captured.repository_id=o.repository_id AND captured.security_domain_id=o.security_domain_id AND captured.object_id=o.object_id AND captured.incarnation_id=o.current_incarnation AND backup.expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM hyperfide.source_retention_roots backup_root WHERE backup_root.organisation_id=o.organisation_id AND backup_root.repository_id=o.repository_id AND backup_root.security_domain_id=o.security_domain_id AND backup_root.object_id=o.object_id AND backup_root.incarnation_id=o.current_incarnation AND backup_root.owner_kind='BACKUP' AND backup_root.state='ACTIVE' AND (backup_root.expires_at IS NULL OR backup_root.expires_at>clock_timestamp())) ORDER BY o.created_at,o.object_id FOR UPDATE OF o,p SKIP LOCKED LIMIT $6`,
          [
            ...retentionScope(scope),
            input.partition,
            policy.minimum_age_seconds,
            input.limit,
          ],
        )
      ).rows;
      const quarantined = [];
      for (const row of rows) {
        const referenced = (
          await tx.query(
            `SELECT 1 FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1`,
            [...retentionScope(scope), row.object_id, row.current_incarnation],
          )
        ).rowCount;
        if (
          referenced ||
          (await backupRetains(
            tx,
            scope,
            row.object_id,
            row.current_incarnation,
          ))
        )
          continue;
        await tx.query(
          `UPDATE hyperfide.source_native_objects SET state='QUARANTINED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4`,
          [...retentionScope(scope), row.object_id],
        );
        await tx.query(
          `UPDATE hyperfide.source_object_placements SET state='QUARANTINED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,
          [...retentionScope(scope), row.object_id, row.current_incarnation],
        );
        const work = (
          await tx.query(
            `INSERT INTO hyperfide.source_collection_work(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,generation,partition,operation_id,storage_key,size_bytes,policy_generation,state,eligible_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'QUARANTINED',clock_timestamp()+($12::integer*interval '1 second')) ON CONFLICT(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) DO UPDATE SET state='QUARANTINED',policy_generation=EXCLUDED.policy_generation,eligible_at=EXCLUDED.eligible_at,quarantined_at=clock_timestamp() RETURNING operation_id`,
            [
              ...retentionScope(scope),
              row.object_id,
              row.current_incarnation,
              row.generation,
              input.partition,
              randomUUID(),
              row.storage_key,
              row.size_bytes,
              policy.generation,
              policy.quarantine_seconds,
            ],
          )
        ).rows[0];
        quarantined.push({
          object_id: row.object_id,
          incarnation_id: row.current_incarnation,
          operation_id: work!.operation_id,
        });
      }
      return { quarantined };
    });
  }
  async collect(
    scope: SourceStorageScope,
    input: { partition: number; limit: number },
    signal?: AbortSignal,
  ) {
    validateStorageScope(scope);
    bounded(input.partition, 15);
    bounded(input.limit, 256);
    if (!input.limit)
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Positive collection limit required",
      );
    const work = await this.database.transaction(async (tx) => {
      const policy = (
        await tx.query(
          "SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE",
          retentionScope(scope),
        )
      ).rows[0];
      if (!policy) return [];
      if (
        policy.backend_identity !== this.backend.identity ||
        policy.independent_expiration
      )
        throw new SourceControlError(
          "RETENTION_POLICY_INVALID",
          "Backend retention policy changed",
        );
      const rows = (
        await tx.query(
          `SELECT w.* FROM hyperfide.source_collection_work w JOIN hyperfide.source_native_objects o ON o.organisation_id=w.organisation_id AND o.repository_id=w.repository_id AND o.security_domain_id=w.security_domain_id AND o.object_id=w.object_id AND o.current_incarnation=w.incarnation_id AND o.generation=w.generation WHERE w.organisation_id=$1 AND w.repository_id=$2 AND w.security_domain_id=$3 AND w.partition=$4 AND w.state IN ('QUARANTINED','DELETE_PENDING') AND o.state=w.state AND w.eligible_at<=clock_timestamp() AND w.quarantined_at<=clock_timestamp()-($6::integer*interval '1 second') AND o.created_at<=clock_timestamp()-($7::integer*interval '1 second') AND NOT EXISTS(SELECT 1 FROM hyperfide.source_backup_objects captured JOIN hyperfide.source_backups backup USING(organisation_id,repository_id,security_domain_id,backup_id) WHERE captured.organisation_id=o.organisation_id AND captured.repository_id=o.repository_id AND captured.security_domain_id=o.security_domain_id AND captured.object_id=o.object_id AND captured.incarnation_id=o.current_incarnation AND backup.expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM hyperfide.source_retention_roots backup_root WHERE backup_root.organisation_id=o.organisation_id AND backup_root.repository_id=o.repository_id AND backup_root.security_domain_id=o.security_domain_id AND backup_root.object_id=o.object_id AND backup_root.incarnation_id=o.current_incarnation AND backup_root.owner_kind='BACKUP' AND backup_root.state='ACTIVE' AND (backup_root.expires_at IS NULL OR backup_root.expires_at>clock_timestamp())) ORDER BY w.eligible_at,w.object_id FOR UPDATE OF o,w SKIP LOCKED LIMIT $5`,
          [
            ...retentionScope(scope),
            input.partition,
            input.limit,
            policy.quarantine_seconds,
            policy.minimum_age_seconds,
          ],
        )
      ).rows;
      const selected = [];
      for (const row of rows) {
        const pins = (
          await tx.query(
            `SELECT 1 FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1`,
            [...retentionScope(scope), row.object_id, row.incarnation_id],
          )
        ).rowCount;
        if (
          pins ||
          (await backupRetains(tx, scope, row.object_id, row.incarnation_id))
        ) {
          if (row.state === "DELETE_PENDING")
            throw new SourceControlError(
              "RETENTION_INVARIANT",
              "Deletion intent has an acquired live pin",
            );
          continue;
        }
        await tx.query(
          `UPDATE hyperfide.source_native_objects SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND current_incarnation=$5`,
          [...retentionScope(scope), row.object_id, row.incarnation_id],
        );
        await tx.query(
          `UPDATE hyperfide.source_object_placements SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,
          [...retentionScope(scope), row.object_id, row.incarnation_id],
        );
        await tx.query(
          `UPDATE hyperfide.source_collection_work SET state='DELETE_PENDING',policy_generation=$6,attempts=attempts+1,last_attempt_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,
          [
            ...retentionScope(scope),
            row.object_id,
            row.incarnation_id,
            policy.generation,
          ],
        );
        selected.push(row);
      }
      return selected;
    });
    const results = [];
    for (const row of work) {
      if (signal?.aborted) break;
      let outcome: "ABSENT" | "UNKNOWN" = "UNKNOWN";
      try {
        outcome = await this.backend.delete(
          row.storage_key,
          row.object_id,
          Number(row.size_bytes),
          signal,
        );
      } catch (error) {
        if (
          error instanceof SourceControlError &&
          error.code === "OBJECT_INTEGRITY"
        )
          outcome = "UNKNOWN";
        else if (error instanceof SourceControlError) throw error;
      }
      await this.database.transaction(async (tx) => {
        await tx.query(
          `SELECT 1 FROM hyperfide.source_native_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 FOR UPDATE`,
          [...retentionScope(scope), row.object_id],
        );
        await tx.query(
          `UPDATE hyperfide.source_collection_work SET last_outcome=$6,state=CASE WHEN $6='ABSENT' THEN 'ABSENT' ELSE state END WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND operation_id=$7`,
          [
            ...retentionScope(scope),
            row.object_id,
            row.incarnation_id,
            outcome,
            row.operation_id,
          ],
        );
        if (outcome === "ABSENT") {
          await tx.query(
            `UPDATE hyperfide.source_object_placements SET state='ABSENT' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,
            [...retentionScope(scope), row.object_id, row.incarnation_id],
          );
          await tx.query(
            `UPDATE hyperfide.source_native_objects SET state='ABSENT' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND current_incarnation=$5 AND generation=$6`,
            [
              ...retentionScope(scope),
              row.object_id,
              row.incarnation_id,
              row.generation,
            ],
          );
          await tx.query(
            `DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='OBJECT' AND owner_id=$4`,
            [
              ...retentionScope(scope),
              row.object_id + "/" + row.incarnation_id,
            ],
          );
        }
      });
      results.push({
        object_id: row.object_id,
        incarnation_id: row.incarnation_id,
        operation_id: row.operation_id,
        outcome,
      });
    }
    return { results };
  }
  async inspect(
    scope: SourceStorageScope,
    input: { partition: number; limit: number; after?: string },
  ) {
    validateStorageScope(scope);
    bounded(input.partition, 15);
    bounded(input.limit, 256);
    if (!input.limit)
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Positive inspection limit required",
      );
    if (input.after) {
      const parts = input.after.split("/");
      parseObjectId(parts[0]);
      if (parts.length !== 1) {
        if (
          parts.length !== 3 ||
          !["COLLECTION", "CHILD_RESERVATION"].includes(parts[1]!)
        )
          throw new SourceControlError(
            "INVALID_REQUEST",
            "Invalid collection debt cursor",
          );
        parseUUID(parts[2], "debt cursor");
      }
    }
    return this.database.transaction(async (tx) => {
      const work = (
        await tx.query<{ entry: SourceCollectionDebt; cursor: string }>(
          `
        SELECT entry,cursor FROM (
          SELECT object_id,object_id||'/COLLECTION/'||incarnation_id::text AS cursor,jsonb_build_object('kind','COLLECTION','object_id',object_id,'incarnation_id',incarnation_id,'generation',generation::text,'operation_id',operation_id,'state',state,'attempts',attempts,'last_outcome',last_outcome,'eligible_at',eligible_at) AS entry
          FROM hyperfide.source_collection_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND partition=$4 AND state IN ('QUARANTINED','DELETE_PENDING')
          UNION ALL
          SELECT r.child_object_id,r.child_object_id||'/CHILD_RESERVATION/'||r.reservation_id::text,jsonb_build_object('kind','CHILD_RESERVATION','debt_kind','PARENT_OUTCOME_UNKNOWN','object_id',r.child_object_id,'incarnation_id',r.child_incarnation_id,'operation_id',r.reservation_id,'reservation_id',r.reservation_id,'parent_object_id',r.parent_object_id,'parent_incarnation_id',r.parent_incarnation_id,'child_object_id',r.child_object_id,'child_incarnation_id',r.child_incarnation_id,'position',r.position,'state','RESERVED')
          FROM hyperfide.source_child_reservations r LEFT JOIN hyperfide.source_object_placements p ON p.organisation_id=r.organisation_id AND p.repository_id=r.repository_id AND p.security_domain_id=r.security_domain_id AND p.object_id=r.parent_object_id AND p.incarnation_id=r.parent_incarnation_id
          WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3 AND get_byte(decode(substr(r.child_object_id,8,2),'hex'),0)%16=$4 AND r.state='RESERVED' AND (p.state IS NULL OR p.state NOT IN ('VERIFIED','ABSENT'))
        ) debt WHERE ($6::text IS NULL OR CASE WHEN position('/' in $6)>0 THEN cursor>$6 ELSE object_id>$6 END) ORDER BY cursor LIMIT $5`,
          [
            ...retentionScope(scope),
            input.partition,
            input.limit,
            input.after ?? null,
          ],
        )
      ).rows;
      return {
        work: work.map(({ entry }) =>
          entry.kind === "COLLECTION"
            ? {
                ...entry,
                eligible_at: new Date(entry.eligible_at).toISOString(),
              }
            : entry,
        ),
        next_cursor: work.length === input.limit ? work.at(-1)!.cursor : null,
      };
    });
  }
}
