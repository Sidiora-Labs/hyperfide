# Native source migration

A migration pins a complete import for each project, its original Git repository and tip, its target path, and one native baseline. Imported history keeps its original provenance and object archive. It does not count as newly authored fleet work.

## Import and projection

Configure readable Git object databases in the owner-private file named by `HF_SOURCE_IMPORT_CONFIG`:

```json
{"sources":[{"id":"project-a","scope":{"organisation_id":"<uuid>","repository_id":"<uuid>","security_domain_id":"<uuid>"},"repository_identity":"project-a","path":"/srv/source/project-a.git"}]}
```

The importer reads bounded Git objects through `cat-file`; it does not check out code or execute repository hooks, filters or submodules. `source.projections.create` registers an immutable policy version. A policy declares source-to-target path mappings, dependencies, handling of unchanged commits and ordered merge parents, public metadata, and signature treatment. Changing a policy requires a new version.

`source.imports.create` pins the configured source, exact tip, policy version, fixed native baseline, and separate object/byte/commit/depth budgets. `source.imports.resume` commits bounded batches. `source.imports.read` reports progress; `source.imports.mappings` pages original-to-native commit mappings. Exact original Git objects remain retained archives. Unsupported modes, missing LFS content, unsupported encodings and signing policies produce explicit diagnostics.

`source.contributions.create` adds a provider contribution identity to those pins. Completion yields a native proposal. Normal qualification and acceptance decide whether that proposal becomes accepted source.

A publication destination may include a `projection_policy` using the same versioned policy shape. Publication revalidates each mapped path and uses the policy digest when reusing Git mappings. Annotated tag conversion keeps the original tagger, timestamp and message and resolves its exact native target; signed tag conversion is refused by the current policy.

## Consolidation and shadow parity

`source.migration.stage` composes a candidate before writer admission closes. Run the native pilot and independent qualification against that exact candidate, accept it, and queue its remote export. `source.migration.prepare` then takes the same versioned manifest with:

- `migration_id` and `base_revision_id`;
- projects containing `project_id`, `import_id`, `source_id`, `source_ref`, `tip_oid` and `target_path`;
- the complete `legacy_writer_ids` inventory and `legacy_source_epoch`;
- public revision provenance;
- `workflow_transition`, naming `source_mode: "native"` and only the legacy source mechanics being superseded.

At least two pinned projects are required. Overlapping or case-colliding roots are refused. The native write gate closes normal mutation admission while the migration is a shadow. Trusted historical ingestion can continue without granting ordinary workers a second source authority.

`source.migration.consolidate` composes the imported project subtrees over the fixed baseline and records their ordered native parents. `source.migration.parity` reads the pinned original Git objects and native objects independently, comparing complete selected file bytes, entry types, modes and ancestry mappings. It also checks the current configured source refs against the final pinned tips.

The manifest records the intended workflow transition. Preparing a manifest does not edit the repository workflow or activate its source mode.

## Quiesce and activate

Activation requires an explicit owner-private profile named by `HF_SOURCE_MIGRATION_CONFIG`:

```json
{"deployment_id":"<uuid>","legacy_source_epoch":"<uuid-or-null>","writer_id":"configured-legacy-writer"}
```

`HF_LEGACY_WRITER_CONFIG_FILE` supplies the matching protected legacy topology used by Hyperfide's existing writer admission and kernel isolation observer. The profile must cover every writer in the manifest. The current implementation accepts one fully observed configured writer; additional or unknown writers are refused.

Before `source.migration.quiesce`, close active workspaces, finish active imports/uploads, and reconcile pending remote publications. Quiesce disables legacy admission and requires fresh kernel evidence that legacy storage aliases are read-only and no writable descriptors or shared mappings remain. It then records the route as `CLOSED`.

`source.migration.activate` takes the pilot `acceptance_id`, verifies that its current evidence names the exact consolidated revision and root, repeats the final source-tip and isolation checks, and atomically advances both native source authority epochs with the route switch to `NATIVE`. Old source capabilities stop authorizing requests. Obtain a capability for the new epoch before continuing.

Every phase carries `migration_id`, a stable `operation_id`, and `expected_generation`. Reusing an operation recovers its recorded result. A different request under the same operation is refused.

## Abort and recovery

Before activation, `source.migration.abort` requires drained work and no acknowledged native writes. It closes native admission and restores the matching legacy admission descriptor. Restoring any external read-only mount is a separate operation under the configured deployment controls.

After activation, rollback to a stale legacy writer is refused. `source.migration.recover` preserves acknowledged revisions, source maps and retained archives, requires external operations to be reconciled, and advances to a fresh native authority epoch. `source.migration.read` exposes the active route, phase, generation and retained work inventory.

Epoch transitions create explicit successor policy and integration-domain IDs. The activation/recovery response contains the `adoption.policy_map` and `adoption.domain_map` needed to continue proposals under the new authority. Only current, unrevoked policies and checker registrations are carried forward; domains without an eligible policy are reported in `skipped_domains`. Historical domains, candidates, qualifications, and acceptance receipts retain their original identities and epochs.

Reading or publishing historical acceptance follows the recorded adoption chain to a current policy and domain, then revalidates the original evidence, including expiry and revocation. A new capability does not bypass revoked historical evidence. New changes must qualify and be accepted against the successor domain before publication.

If legacy refs advance during shadowing, isolate legacy storage, import each final tip under its existing projection policy, and call `source.migration.refresh` with the current generation and replacement manifest. Refresh changes only import/tip pins: project identities, target paths, refs, base revision, writer coverage and transition policy stay fixed. Every prior tip must remain in the new imported ancestry. The server repeats exact ref checks and native parity under observed isolation, records a linked immutable manifest generation, and leaves the route closed.

The refreshed consolidated revision requires its own independent qualification and acceptance before activation. Candidate, domain and assurance metadata remain available during this closed phase; ordinary authored revision creation remains fenced. The previous pilot cannot authorize activation of a changed root. `source.migration.read` returns the current manifest; immutable manifest history remains in `source_cutover_manifests` alongside the retained phase receipts.
