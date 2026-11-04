# Native source recovery

A recovery profile states the failure model before the service claims readiness. It names the metadata acknowledgment mode and failure domains, every required immutable object placement, verified storage capabilities, backup retention, an independent authority journal, and RPO/RTO objectives. The schema is `deploy/hyperfide/source-control/recovery-profile.schema.json`.

`FSYNC_PRIMARY` requires an fsync-enabled PostgreSQL primary. `SYNC_REPLICA` also requires an observed streaming synchronous replica when capturing a backup. A profile claiming loss of a failure domain must name distinct metadata and object failure domains. Backend identifiers alone do not establish replication: every required backend must be configured and every retained object is read and verified there.

## Capture and verify

Call `source.backups.create` with an immutable `backup_id`, the profile, expiry and explicit revision/object/byte budgets. Capture locks the source repository while it records the revision inventory and unresolved upload, collection and publication identities. Each root receives a durable backup pin. Exceeding a budget refuses capture rather than truncating its inventory.

The source manifest accompanies the PostgreSQL physical backup. Capture them from the same consistent metadata inventory; restore verification refuses additional or missing revisions as well as changed descriptors. Keep the external authority journal outside the restored database and its snapshot. Preserve the manifest, profile digest and backup identifier with the physical backup inventory.

Call `source.backups.verify` with a bounded batch size until the state is `READY`. Verification follows actual immutable child references and checks every object envelope against its native identity at every required placement. Missing or corrupted bytes leave the backup `FAILED`; an unavailable placement cannot certify readiness. `source.backups.read` reports the retained manifest and progress.

## Restore

1. Use the existing external writer-fencing workflow to isolate prior writers and verify their absence. Restore PostgreSQL into an isolated target and reestablish the acknowledgment mode required by its profile.
2. Complete the core `storage.authority` restored activation against the independent journal. Preserve the original activation operation and predecessor identities while reconciling an uncertain activation.
3. Call `source.recovery.prepare` with the backup and positively verified external activation. This resets object verification for that activation and fences ordinary source mutations until activation completes; copied `READY` metadata never substitutes for a new read of object storage.
4. Run `source.backups.verify` to completion. A missing-object failure must be repaired from a verified retained placement or backup before continuing.
5. Call `source.recovery.activate`. The trusted activation verifier checks the current external journal and committed restored activation. The source authority generation advances only after the new closure verification succeeds. Refresh source credentials for the successor generation.

The manifest retains unresolved upload, collection and Git-publication operation identities. Reconcile those operations against actual external state using their original identities. Completed effects remain completed. An unknown deletion targets its original physical incarnation, while an uncertain Git export retains its exact publication operation and destination state.

## Routing

Every source service uses `SourceRoutedObjectCatalog`. An unspecified owner may write only while the partition is unassigned; after ownership is configured, that service must identify the matching owner. Mutating catalog transactions hold the partition route generation while committing, and initial ownership assignment waits for already admitted unconfigured transactions. `source.routing.move` advances the owner with an expected-generation check; obsolete owners cannot begin or complete uploads after the move. Existing immutable reads continue through the shared object placements. The route response declares shared storage explicitly; changing an owner does not imply a copy to another backend.

## Qualification

Run `python3 tests/hyperfide/cases/source_control/6_1.py` for owned PostgreSQL physical replication, crash, promotion and restore against the configured source/artifact S3 backend with a fresh isolated source scope. Use `--component` for the signed S3 fixture. Receipts under `build/source-control/6.1/` retain the exact acknowledgment inventory, manifest, profile, failure schedule and measured recovery duration. Same-host PostgreSQL evidence qualifies process and primary-instance faults; it does not establish cross-host or cross-region failure independence.

Recovery separately reconciles external effects captured by the backup. `source.recovery.reconcile` accepts the backup, the current preparation operation, and a bounded item limit. It observes the exact upload placement, finishes only an already recorded conditional deletion, and uses readback for an issued Git publication. It never creates a replacement upload or sends another push. An unavailable observation leaves the effect pending. Unacknowledged uploaded bytes remain unacknowledged after reconciliation.

The backup manifest includes active retention roots as well as revision roots, so retained evidence, custody, imports, exports and holds outside a revision tree are included in closure verification. A completed object scan does not authorize reopening writes: activation also requires every captured external effect to have a durable resolved outcome. The recovery profile applies to the captured recovery point; effects issued after that point require their independent retained journal or inventory.

Backup manifest version 2 adds the complete retained-root and external-effect inventories. This version is independent of native source object format version 1. Older backup manifests remain inspectable, but verification and preparation return `BACKUP_FORMAT_UNSUPPORTED`; they cannot establish restoration readiness. Capture and verify a new version-2 backup while the current authority is healthy before relying on the upgraded service for recovery.

After external activation and `source.recovery.prepare`, call `source.recovery.reconcile` repeatedly with the same preparation operation and a bounded `limit` until `remaining_effects` reaches zero. Replay of preparation does not reset resolved effects. An unknown remote head or unavailable object observation keeps the relevant effect pending and source mutations fenced. Only then may activation reopen source writes; object verification can finish while effect debt remains. An effect outside the captured recovery point returns `BACKUP_INCOMPLETE` and requires a recovery point or independently retained inventory that includes it.
