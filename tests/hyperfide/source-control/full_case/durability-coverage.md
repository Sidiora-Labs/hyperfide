# Durability full-case execution

`durability.py --case SCM-NNN` runs the registered driver set and emits the exact assertion inventory only after every driver exits successfully. Each invocation creates a unique evidence directory. Earlier task receipts remain intact.

| Case | Required variant | Executed boundaries |
| --- | --- | --- |
| SCM-002 | real-s3 | Native object type/readback and actual multipart completion; synchronous metadata acknowledgment; interrupted upload and revision processes; physical failover and reconstruction |
| SCM-005 | full | Actual PostgreSQL pin/quarantine races; delayed deletion and replacement incarnation; every declared retention root class with independent tree/file/blob reads; revoked collection authority; restored writer fencing |
| SCM-018 | metadata-failover | Owned PostgreSQL18 synchronous standby promotion and physical restore, actual S3, independent accepted-revision and publication inventories, causal token failures and old authority rejection |
| SCM-019 | restore | Retained revision and non-revision closure, missing evidence object rejection, uploaded/deleted/exported effect reconciliation, actual Git readback, and isolated legacy-to-native recovery |

The live storage phases require configured S3 credentials. Missing credentials fail execution. The supported recovery faults are process loss and primary-instance loss. The tests explicitly reject a failure-domain-loss claim and exercise absence of a synchronous replica. A local SigV4 fixture is used for deterministic delayed/lost request races; its observations are labeled separately from actual S3.

Recovery reconciliation operates on the exact captured effect inventory. An object scan alone cannot reopen writes: pending or unknown effects, a different preparation operation, expired authority, an uncaptured effect, or missing retained bytes refuse readiness or activation. Unacknowledged uploaded bytes remain unacknowledged. Remote reconciliation observes the existing issued Git OID and does not send another push.

`durability_cases.json` names the independently executed checks used by each case. Registrations bind source inputs and mandatory assertion IDs; canonical qualification additionally requires the actual native source capture through the shared manifest/qualifier workflow.
