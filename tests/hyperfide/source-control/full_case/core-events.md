# Event delivery qualification

`events.py` executes the authenticated source API against owned PostgreSQL and the SigV4 object fixture. `1_2.py` separately exercises a delayed committing transaction behind an already delivered transaction. Both use migration 0758 through the shared fixture's explicit migration list.

Subscriptions retain at most their requested `retention_max_events` (1–100000; default 10000), until `retention_expires_at` (default 24 hours, at most seven days). Retention counts acknowledged inbox records as well as pending deliveries: acknowledging an event does not create unlimited historical deduplication state.

A source transaction appends its immutable event obligation without visiting or locking subscribers. Polling locks only its own subscription, discovers a bounded page of committed events not already delivered, and retains exact event and lease identities. Discovery never advances a bare sequence high-water mark; a lower transaction identity committing later remains discoverable.

An exceeded event/deadline budget produces `RESNAPSHOT_REQUIRED`. Explicit creation with `expected_previous_epoch` establishes a new boundary for the caller-selected immutable bootstrap. PostgreSQL transaction snapshots distinguish events already visible at that boundary from later commits. There is no implied global branch head. Prior subscription epochs cannot poll or acknowledge the new boundary.

Resnapshot cleanup removes at most 4096 retired delivery/inbox records per transaction. `RESNAPSHOT_PENDING` means retry the same expected epoch. Inbox records belonging to an active subscription remain protected by the database immutability trigger; only an explicitly retired subscription can delete its old inbox during bounded cleanup. Source events themselves remain immutable.

The subscription's source authority epoch is checked independently of its delivery epoch. Restored or advanced source authority requires an explicit current boundary before old PostgreSQL snapshot identities can be used again.
