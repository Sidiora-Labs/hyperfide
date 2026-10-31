# Native source-control traceability

Generated from [spec.kvx](spec.kvx). A clause `N.M` is `[req.N] ac_M`. Mappings describe planned coverage, not execution evidence. All product cases are UNRUN.

| Clause | Requirement | Implementation tasks | Product cases | Contract |
|---|---|---|---|---|
| 1.1 | Online asymmetric native source control inside Hyperfide | 0.1, 2.1, 4.2, 7.2 | SCM-004, SCM-023 | [design.body.md](design.body.md) |
| 1.2 | Online asymmetric native source control inside Hyperfide | 0.1, 2.1, 7.2 | SCM-006, SCM-023 | [design.body.md](design.body.md) |
| 1.3 | Online asymmetric native source control inside Hyperfide | 0.1, 1.1, 6.2, 7.2 | SCM-020, SCM-023 | [design.body.md](design.body.md) |
| 1.4 | Online asymmetric native source control inside Hyperfide | 0.1, 1.1, 1.2, 6.2, 7.2 | SCM-020, SCM-023 | [design.body.md](design.body.md) |
| 1.5 | Online asymmetric native source control inside Hyperfide | 0.1, 2.2, 3.2, 7.2 | SCM-010, SCM-011, SCM-023 | [design.body.md](design.body.md) |
| 1.6 | Online asymmetric native source control inside Hyperfide | 0.1, 5.1, 7.2 | SCM-015, SCM-023 | [design.body.md](design.body.md) |
| 1.7 | Online asymmetric native source control inside Hyperfide | 0.1, 4.2, 7.2 | SCM-014, SCM-023 | [design.body.md](design.body.md) |
| 1.8 | Online asymmetric native source control inside Hyperfide | 0.1, 2.1, 4.2, 7.2 | SCM-014, SCM-023 | [design.body.md](design.body.md) |
| 2.1 | Immutable source identities and bounded persistent trees | 1.1 | SCM-001 | [storage.md](storage.md) |
| 2.2 | Immutable source identities and bounded persistent trees | 1.1 | SCM-001, SCM-020 | [storage.md](storage.md) |
| 2.3 | Immutable source identities and bounded persistent trees | 1.1 | SCM-001 | [storage.md](storage.md) |
| 2.4 | Immutable source identities and bounded persistent trees | 1.1 | SCM-001, SCM-020 | [storage.md](storage.md) |
| 2.5 | Immutable source identities and bounded persistent trees | 1.1, 6.1 | SCM-020 | [storage.md](storage.md) |
| 2.6 | Immutable source identities and bounded persistent trees | 1.1 | SCM-020 | [storage.md](storage.md) |
| 3.1 | S3 persistence, acknowledgment and safe incremental reclamation | 1.1, 6.1 | SCM-002, SCM-022 | [storage.md](storage.md) |
| 3.2 | S3 persistence, acknowledgment and safe incremental reclamation | 1.1, 6.1 | SCM-002, SCM-018, SCM-022 | [storage.md](storage.md) |
| 3.3 | S3 persistence, acknowledgment and safe incremental reclamation | 1.1, 1.3 | SCM-010, SCM-022 | [storage.md](storage.md) |
| 3.4 | S3 persistence, acknowledgment and safe incremental reclamation | 2.3, 6.1 | SCM-005, SCM-019 | [storage.md](storage.md) |
| 3.5 | S3 persistence, acknowledgment and safe incremental reclamation | 2.3, 6.1 | SCM-005, SCM-019 | [storage.md](storage.md) |
| 3.6 | S3 persistence, acknowledgment and safe incremental reclamation | 2.3, 6.1 | SCM-018, SCM-019 | [storage.md](storage.md) |
| 4.1 | Immutable changes and incremental server-side transformations | 1.2 | SCM-003 | [protocol.md](protocol.md) |
| 4.2 | Immutable changes and incremental server-side transformations | 1.2, 2.1 | SCM-001, SCM-020 | [protocol.md](protocol.md) |
| 4.3 | Immutable changes and incremental server-side transformations | 3.1 | SCM-008 | [protocol.md](protocol.md) |
| 4.4 | Immutable changes and incremental server-side transformations | 3.1 | SCM-003, SCM-008 | [protocol.md](protocol.md) |
| 4.5 | Immutable changes and incremental server-side transformations | 1.2, 2.1, 4.1 | SCM-002, SCM-003 | [protocol.md](protocol.md) |
| 4.6 | Immutable changes and incremental server-side transformations | 3.1 | SCM-008, SCM-021 | [protocol.md](protocol.md) |
| 5.1 | Complete versioned source API and committed event replay | 2.1, 3.1 | SCM-006 | [protocol.md](protocol.md) |
| 5.2 | Complete versioned source API and committed event replay | 2.1 | SCM-006, SCM-012 | [protocol.md](protocol.md) |
| 5.3 | Complete versioned source API and committed event replay | 1.2, 2.1, 3.1, 4.1 | SCM-003 | [protocol.md](protocol.md) |
| 5.4 | Complete versioned source API and committed event replay | 1.2, 2.1, 4.1 | SCM-007 | [protocol.md](protocol.md) |
| 5.5 | Complete versioned source API and committed event replay | 1.2, 2.1 | SCM-006, SCM-007, SCM-018 | [protocol.md](protocol.md) |
| 5.6 | Complete versioned source API and committed event replay | 2.1, 3.1 | SCM-006, SCM-007, SCM-020 | [protocol.md](protocol.md) |
| 6.1 | Online workspaces with bounded sparse and virtual materialization | 2.2, 3.2 | SCM-010, SCM-011 | [workspaces.md](workspaces.md) |
| 6.2 | Online workspaces with bounded sparse and virtual materialization | 2.2, 3.2 | SCM-010 | [workspaces.md](workspaces.md) |
| 6.3 | Online workspaces with bounded sparse and virtual materialization | 2.2, 3.2 | SCM-010, SCM-011 | [workspaces.md](workspaces.md) |
| 6.4 | Online workspaces with bounded sparse and virtual materialization | 2.2, 3.2 | SCM-010, SCM-011 | [workspaces.md](workspaces.md) |
| 6.5 | Online workspaces with bounded sparse and virtual materialization | 2.2, 4.2 | SCM-010, SCM-011 | [workspaces.md](workspaces.md) |
| 6.6 | Online workspaces with bounded sparse and virtual materialization | 3.2 | SCM-011 | [workspaces.md](workspaces.md) |
| 7.1 | Exact-evidence candidates and atomic source acceptance | 1.2, 2.1, 4.1 | SCM-009, SCM-014 | [protocol.md](protocol.md) |
| 7.2 | Exact-evidence candidates and atomic source acceptance | 4.1 | SCM-009 | [protocol.md](protocol.md) |
| 7.3 | Exact-evidence candidates and atomic source acceptance | 4.1 | SCM-009 | [protocol.md](protocol.md) |
| 7.4 | Exact-evidence candidates and atomic source acceptance | 3.1, 4.1 | SCM-008, SCM-009, SCM-012 | [protocol.md](protocol.md) |
| 7.5 | Exact-evidence candidates and atomic source acceptance | 4.1 | SCM-009, SCM-021 | [protocol.md](protocol.md) |
| 7.6 | Exact-evidence candidates and atomic source acceptance | 4.1 | SCM-009, SCM-015 | [protocol.md](protocol.md) |
| 8.1 | Hyperfide task authority integrated with native source transactions | 4.2 | SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 8.2 | Hyperfide task authority integrated with native source transactions | 4.2 | SCM-004, SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 8.3 | Hyperfide task authority integrated with native source transactions | 4.2 | SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 8.4 | Hyperfide task authority integrated with native source transactions | 3.3 | SCM-012, SCM-020, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 8.5 | Hyperfide task authority integrated with native source transactions | 4.2, 4.3 | SCM-009, SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 8.6 | Hyperfide task authority integrated with native source transactions | 4.2, 4.3 | SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 9.1 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.2 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1, 5.2 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.3 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1, 5.2 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.4 | GitHub and GitLab compatibility exists only at the remote boundary | 5.2 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.5 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.6 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1 | SCM-015 | [git-interop.md](git-interop.md) |
| 9.7 | GitHub and GitLab compatibility exists only at the remote boundary | 5.1, 5.2 | SCM-013, SCM-015 | [git-interop.md](git-interop.md) |
| 9.8 | GitHub and GitLab compatibility exists only at the remote boundary | 5.2 | SCM-016 | [git-interop.md](git-interop.md) |
| 10.1 | Existing projects and history consolidate into one authoritative monorepo | 5.2, 5.3 | SCM-016, SCM-017 | [migration.md](migration.md) |
| 10.2 | Existing projects and history consolidate into one authoritative monorepo | 5.2, 5.3 | SCM-016, SCM-017 | [migration.md](migration.md) |
| 10.3 | Existing projects and history consolidate into one authoritative monorepo | 5.2, 5.3 | SCM-016, SCM-017 | [migration.md](migration.md) |
| 10.4 | Existing projects and history consolidate into one authoritative monorepo | 5.3 | SCM-016, SCM-017 | [migration.md](migration.md) |
| 10.5 | Existing projects and history consolidate into one authoritative monorepo | 5.3 | SCM-017 | [migration.md](migration.md) |
| 10.6 | Existing projects and history consolidate into one authoritative monorepo | 5.3 | SCM-017 | [migration.md](migration.md) |
| 10.7 | Existing projects and history consolidate into one authoritative monorepo | 5.3 | SCM-017, SCM-019 | [migration.md](migration.md) |
| 10.8 | Existing projects and history consolidate into one authoritative monorepo | 5.3 | SCM-017 | [migration.md](migration.md) |
| 11.1 | Scoped source access, integrity and recovery authority | 1.3, 6.1 | SCM-004, SCM-013 | [identity-security.md](identity-security.md) |
| 11.2 | Scoped source access, integrity and recovery authority | 1.3 | SCM-013 | [identity-security.md](identity-security.md) |
| 11.3 | Scoped source access, integrity and recovery authority | 1.3, 2.3, 6.1 | SCM-004, SCM-013 | [identity-security.md](identity-security.md) |
| 11.4 | Scoped source access, integrity and recovery authority | 1.1, 1.3 | SCM-013 | [identity-security.md](identity-security.md) |
| 11.5 | Scoped source access, integrity and recovery authority | 1.3 | SCM-013 | [identity-security.md](identity-security.md) |
| 11.6 | Scoped source access, integrity and recovery authority | 1.3, 2.3, 6.1 | SCM-004, SCM-005, SCM-018, SCM-019 | [identity-security.md](identity-security.md) |
| 12.1 | Within-monorepo scale, measured growth and honest qualification | 6.2, 6.3 | SCM-001, SCM-002, SCM-003, SCM-004, SCM-005, SCM-006, SCM-007, SCM-008, SCM-009, SCM-010, SCM-011, SCM-012, SCM-013, SCM-014, SCM-015, SCM-016, SCM-017, SCM-018, SCM-019, SCM-020, SCM-021, SCM-022, SCM-023, SCM-024 | [verification.md](verification.md) |
| 12.2 | Within-monorepo scale, measured growth and honest qualification | 6.2 | SCM-021, SCM-022 | [verification.md](verification.md) |
| 12.3 | Within-monorepo scale, measured growth and honest qualification | 6.2 | SCM-021 | [verification.md](verification.md) |
| 12.4 | Within-monorepo scale, measured growth and honest qualification | 6.2 | SCM-020 | [verification.md](verification.md) |
| 12.5 | Within-monorepo scale, measured growth and honest qualification | 6.2 | SCM-020, SCM-021, SCM-022 | [verification.md](verification.md) |
| 12.6 | Within-monorepo scale, measured growth and honest qualification | 6.2, 6.3 | SCM-014, SCM-015, SCM-022, SCM-023, SCM-024 | [verification.md](verification.md) |
| 12.7 | Within-monorepo scale, measured growth and honest qualification | 6.3 | SCM-005, SCM-018, SCM-019, SCM-022, SCM-024 | [verification.md](verification.md) |
| 13.1 | Usable native source journeys and bounded operational visibility | 4.3 | SCM-006, SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 13.2 | Usable native source journeys and bounded operational visibility | 4.3 | SCM-014, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 13.3 | Usable native source journeys and bounded operational visibility | 3.3, 4.3 | SCM-021, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 13.4 | Usable native source journeys and bounded operational visibility | 3.3, 4.3 | SCM-011, SCM-021, SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 13.5 | Usable native source journeys and bounded operational visibility | 4.3 | SCM-023 | [hyperfide-integration.md](hyperfide-integration.md) |
| 14.1 | Versioned adoption, documentation and release evidence | 0.1, 0.2, 7.1, 7.2 | SCM-024 | [README.md](README.md) |
| 14.2 | Versioned adoption, documentation and release evidence | 7.1, 7.2 | SCM-023 | [README.md](README.md) |
| 14.3 | Versioned adoption, documentation and release evidence | 0.2, 7.1, 7.2 | SCM-023 | [README.md](README.md) |
| 14.4 | Versioned adoption, documentation and release evidence | 0.1, 0.2, 0.9, 5.3, 7.1, 7.2 | SCM-017, SCM-024, SCM-025 | [README.md](README.md) |
| 14.5 | Versioned adoption, documentation and release evidence | 7.2 | SCM-023, SCM-024 | [README.md](README.md) |
| 15.1 | Category-based repository layout before native source-control implementation | 0.3, 0.5, 0.6, 0.7, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.2 | Category-based repository layout before native source-control implementation | 0.3, 0.5, 0.6, 0.7, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.3 | Category-based repository layout before native source-control implementation | 0.4, 0.6, 0.8, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.4 | Category-based repository layout before native source-control implementation | 0.4, 0.5, 0.6, 0.7, 0.8, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.5 | Category-based repository layout before native source-control implementation | 0.4, 0.8, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.6 | Category-based repository layout before native source-control implementation | 0.3, 0.5, 0.6, 0.7, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.7 | Category-based repository layout before native source-control implementation | 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |
| 15.8 | Category-based repository layout before native source-control implementation | 0.3, 0.8, 0.9 | SCM-025 | [repository-layout.md](repository-layout.md) |

## Canonical case ownership

A case's tasks are the implementation packages responsible for its driver, behavior or final integration. Full-case completion requires every registered assertion and mandatory backend/campaign variant described in [verification.md](verification.md).

| Case | Scope | Tasks | Independent oracle |
|---|---|---|---|
| SCM-001 | Canonical immutable object and tree identity (component) | 0.1, 1.1 | Canonical tree reconstruction and explicit rejection of noncanonical or escaping entries. |
| SCM-002 | S3 uploads and durable revision boundaries (backend) | 1.1, 1.2 | Every acknowledged revision reconstructs from verified durable objects after each supported interrupted write. |
| SCM-003 | Idempotent native operations and divergence (component) | 1.2, 2.1 | Request ledgers and immutable histories show one result per identical operation and explicit divergent revisions. |
| SCM-004 | Attempt fencing and online authority (integration) | 1.3, 4.2 | Obsolete/disconnected attempts cannot mutate or accept source under stale authority. |
| SCM-005 | Retention and garbage-collection races (backend) | 2.3 | Independent reachability and object retrieval prove no rooted content is swept during concurrent writes or pinning. |
| SCM-006 | API-only history queries and pinned pagination (component) | 2.1 | Results match immutable reference trees/history without client checkout or substituted index coverage. |
| SCM-007 | Committed event replay and resynchronization (component) | 1.2, 2.1 | Client state converges to every committed effect despite delayed commits and cursor retention gaps. |
| SCM-008 | Server merge rebase and revert (component) | 3.1 | Result trees match independent three-way vectors or expose structured conflicts while inputs stay immutable. |
| SCM-009 | Atomic acceptance of exactly qualified candidates (integration) | 4.1 | Acceptance history contains only current authorized candidates and exact matching evidence. |
| SCM-010 | Sparse materialization and writable-cache isolation (integration) | 2.2 | Manifest-selected files match pinned bytes/types and absent paths do not become deletions. |
| SCM-011 | Virtual workspace coherence and bounded cache (integration) | 3.2 | Snapshot-consistent filesystem behavior and change reconciliation preserve dirty data across eviction and outages. |
| SCM-012 | Incremental source-pinned graph coverage (integration) | 3.3 | Graph observations identify exact source/extractor/coverage and detect affected consumers and incomplete generations. |
| SCM-013 | Scoped source authorization and export privacy (integration) | 1.3 | All source/query/cache paths reject unauthorized scope and public projection contains only allowed data. |
| SCM-014 | Hyperfide task source custody and taskless clients (live-fleet) | 4.2, 4.3 | Actual assignments preserve attempt/source lineage and submitted custody while taskless callers use independent authorization. |
| SCM-015 | GitHub and GitLab remote export reconciliation (live-remote) | 5.1 | Independently retrieved remote Git trees/parents match selected native source and ambiguous pushes reconcile. |
| SCM-016 | Contribution and history import provenance (integration) | 5.2 | Imported proposals preserve tree and ancestry provenance with idempotent replay and separate import counters. |
| SCM-017 | Monorepo migration cutover and writable rollback (integration) | 5.3 | One writer authority survives cutover and rollback reconciles every acknowledged post-cutover revision. |
| SCM-018 | Supported service and metadata failure recovery (backend) | 6.1 | Independent acknowledgment/acceptance histories survive the declared faults and stale epochs remain fenced. |
| SCM-019 | Backup restore and external-effect reconciliation (backend) | 6.1 | All required reachable objects and configured recovery points reconcile before fresh authority reopens writes. |
| SCM-020 | Growth invariance and within-repository sharding (scale) | 6.2 | Fixed-change latency/work measurements meet declared growth budgets without unrelated full-tree enumeration. |
| SCM-021 | Concurrent mixed-load and admission profiles (scale) | 6.2 | Actual offered/completed workload, bounded resources and correctness satisfy separate active/burst/open profiles. |
| SCM-022 | Real S3 and elapsed-time endurance (live-storage) | 6.2 | Actual S3 traffic and 72 elapsed hours establish sustained new revisions while client and real-worker counts stay separate. |
| SCM-023 | End-to-end native Hyperfide source-control journey (live-fleet) | 6.3, 7.1, 7.2 | A second client and durable records confirm the actual user journey including conflict, recovery, acceptance and remote status. |
| SCM-024 | Strict harness and independent evidence closure (closure) | 0.2, 6.3, 7.2 | False-success and tampering probes fail and a full current assertion/variant inventory is required for closure. |
| SCM-025 | Category layout and existing-system behavior preservation (prerequisite) | 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9 | Complete path/content/mode and identity accounting plus actual existing-system build/runtime/package/cache/CI/preparation checks prove the new category layout; no native SCM dependency or old source facade is required. |
