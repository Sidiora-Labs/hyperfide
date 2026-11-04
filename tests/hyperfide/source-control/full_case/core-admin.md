# Source administrative API verification

`python3 tests/hyperfide/cases/source_control/admin.py` uses actual HTTP, SDK, PostgreSQL and SigV4-backed source objects. It covers five independent contracts:

1. `source.capabilities.manage` grants/revokes a stable capability identity, records one durable operation, returns the original result on retry, and fences later reads after revocation.
2. `source.audit.read` returns bounded pages under current scoped authority. Successful grant/revoke operations append one transactional, allowlisted audit record without credential bytes.
3. A delegated administrator cannot widen its path authority. Unknown credential fields and excessive action lists are refused.
4. `source.workspaces.widen` requires expected workspace and scope generations, permits only monotonic read/write scope growth, and preserves the base revision, root and checkpoint identities.
5. Unauthorized or stale widening leaves the workspace unchanged.

SDK methods are `manageCapability(input, options)`, `audit({limit, after_id}, options)` and `widenWorkspace(input, options)`. Mutation options carry the stable `operation_id` and `idempotency_key`; retain both when retrying. Grant input is `{operation: 'grant', capability: {...}}`; revocation is `{operation: 'revoke', capability_id}`. Omitted grant IDs derive from the operation ID. Audit pages return `records` and `next_after_id`.

These administrative methods are not included in the Primary agent's default action list. They require explicit current authority.
