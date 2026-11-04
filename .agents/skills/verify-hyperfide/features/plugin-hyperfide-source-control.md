# Native source control

This guide owns the native source plugin, source CLI, SDK, signed transport and
workspace adapters. Record each row separately. The component harness uses real
PostgreSQL, source HTTP, object storage protocol and browser components; its
project metadata and local Git destination are declared fixtures. It does not
establish a hosted provider, full application router or capacity pass.

## Setup and source

Use the main skill's isolated app, doctor and cleanup rules for an application
journey. In that test store enable **Source control**. Its navigation panel is
`source-control`; the registered panel id is `hyperfide-source-control`.
In plugin settings, **Native source projects** is a JSON array of projectId,
protected server-side configFile and optional named revisions/assignments.
A host filesystem journey also needs an enrolled hostId and an absolute
hostConfigFile on that host. Use a disposable source repository/security domain.
Never paste private keys or connection-file contents into evidence or settings.

Authoritative entry points:

- `plugins/hyperfide-source-control/{app.tsx,contract.ts,server.ts,runtime.ts}`
- `plugins/hyperfide-source-control/views/{workspace-detail,change-detail,publication-status,transfer-status,metrics}.tsx`
- `plugins/hyperfide-source-control/cli/index.ts`; `apps/cli/src/source-control.ts`
- `sdk/source-control/src/{client,signed,contracts}.ts`
- `core/host-daemon/src/source-control/`; `plugins/environment-slices/host.ts`
- `core/control-plane/src/source_control/{api,workspaces,metrics,events,candidate_queue}.ts`

For repeatable component coverage, with the repository's supported Node runtime
and existing dependencies, use:

```sh
python3 tests/hyperfide/cases/source_control/4_3.py
HF_SOURCE_PRODUCT_CLI=1 python3 tests/hyperfide/cases/source_control/signed_transport.py
```

Unset any inherited DATABASE_URL before these commands; they create their own
PostgreSQL test server through withpg.py. HYPERFIDE_PG_BIN may identify an
installed PostgreSQL runtime. The product driver enables its browser and signed
CLI phases by default; HF_SOURCE_BROWSER=0 or HF_SOURCE_PRODUCT_CLI=0 omits that
phase and must be recorded as unexecuted. The browser needs the built app's CSS
and Chromium. A component run does not need a production .env or remote bucket.

For direct source CLI use the main skill's built `node apps/cli/dist/index.js`
entry, then `source --config /private/test-source.json --help`. The protected
configuration selects the signed endpoint, exact source scope and credential.
Use `--operation-id UUID` before the subcommand for a replay. Do not use the
installed CLI as evidence for a different checkout.

## Recipes

| Feature | Drive | Observable result and boundary |
| --- | --- | --- |
| Configuration and scope | Open Source control, select the disposable project, then select a project with no connection. Exercise the same configured scope with `source revision REVISION`. | Named revisions belong to the selected project. Unconfigured projects say connection required; credentials never appear in the page or response. |
| API-only workspace | On Workspace choose a named Revision, enter existing relative Paths (one per line), select API only, then Open workspace and Refresh workspace. Repeat via `source open REVISION --read-path PATH --write-path PATH --mode API_ONLY`. | Workspace id, source root and generations are durable and agree between clients. No filesystem materialization is implied by opening a handle. |
| Durable text checkpoint | Load file from revision, change File content and Save durable checkpoint. CLI equivalent is `source checkpoint WORKSPACE PATH --file TEXT --base REVISION --workspace-generation N --scope-generation N --overlay-generation N`. | Re-read content through another client. Returned revision and workspace generation advance once; stale generations and writes outside granted paths refuse without replacing the committed state. Text CLI input is bounded to 64 KiB. |
| Lost response and replay | Interrupt the response to an admitted checkpoint in an owned fixture. Reload the panel, retain its Unresolved operation id, choose Read operation status or Retry same operation. | Session storage preserves the original operation; the same request produces one revision. New mutation controls remain blocked while that operation is unresolved. Check server operation state, not only a success notification. |
| Sparse/materialized/virtual host | Select Sparse files or Materialized files and use the configured enrolled host. For Virtual files first read host capability, then attach and edit the mounted file before checkpoint. | Actual host files/mount and durable journal agree with the source revision. Virtual remains disabled without supported host capability; an unavailable mount does not silently become materialized. Missing provider/FUSE access is a prerequisite, not a pass. |
| History and diff | In Changes enter Revision and Read history; set Compare from and Compare revisions. CLI: `source history REVISION`, `source diff BEFORE AFTER`, then follow returned cursors. | Paths and content match independent revision reads. Coverage/cursors stay explicit; a page is not complete ancestry or a full diff unless reported complete. |
| Merge and conflict resolution | Create conflicting edits in two owned branches, Merge revisions, then supply a genuine Resolved workspace revision and Apply resolved revision. Inspect `source transformation OPERATION`. | Conflict state precedes resolution; a completed transformation references the intended resolved content. Error/retry preserves the transformation's original identity. |
| Submission and acceptance | Read Assignment, submit the exact workspace revision with current assignment/workspace generations, then qualify Candidate using independently executed evidence and Accept candidate. CLI has assignment, submit, qualify and accept commands. | Source custody, qualification and acceptance are distinct durable records. Forged/stale evidence and stale assignment ownership fail. Creating a checkpoint alone is not acceptance. |
| Git publication | On Publication provide an actual Acceptance receipt, Configured destination and Target reference. Read status and exercise Resume or Cancel with the original operation. CLI: publish/publication/resume-publication/cancel-publication. | Read the destination with Git independently and compare commit/content. Lost acknowledgment is reconciled without another push. Local Git proves protocol behavior; remote GitHub requires its own authorized disposable destination. GitLab is optional unless explicitly included in the deployment scope. |
| Transfer lifecycle | On Transfers inspect partial progress, complete a real uploaded object, and cancel a separate pending transfer. CLI: transfer, complete-transfer and cancel-transfer. | Persisted offsets/state match bytes transferred; completion verifies object identity, cancellation prevents later progress, and grants/secrets stay out of rendered receipts. |
| Metrics | Open Metrics and compare with `source metrics --max-rows 256` in the same scope. | Product request counts are distinct from source samples. Storage/operation cards display observed time, row budget, partial/unavailable coverage and observed partitions. A sampled count is never labeled a repository total. Check desktop/tablet/mobile overflow with populated data. |
| Signed authority | Run the signed transport/CLI driver; exercise wrong key, expired/revoked authority and path scope failures against the same owned listener. | Correct TLS peer and request signatures succeed; wrong keys, replay and out-of-scope writes fail. Retrying an unknown response preserves the operation id. |
| Operator capability and audit | In an explicitly scoped operator fixture use SDK `manageCapability({operation:"grant",capability:{principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at}}, options)`, then revoke with `{operation:"revoke",capability_id}`. Read SDK `audit({limit,after_id})`. | A narrowly granted action succeeds, revoked authority refuses the next call, and bounded audit pages identify the actual operator and target. Ordinary worker credentials cannot perform administration. Keep grant/revoke operation IDs stable on retries. |
| Explicit scope widening | Use SDK `widenWorkspace({workspace_id,expected_workspace_generation,expected_scope_generation,read_paths,write_paths}, options)` on an owned workspace. | Added paths require an explicit authorized request; returned generations advance, old generations refuse, and another client reads the same new scope. No CLI or UI control is implied when the SDK is the exposed entry point. |


## Evidence and cleanup

The product driver writes `build/source-control/product/receipt.json` and
`build/source-control/product/browser/receipt.json` plus desktop, tablet and
mobile screenshots. Inspect these files and screenshots from the current run;
existing files are not a new pass. Signed transport writes its separate receipt
under `build/source-control/signed-transport/`. Keep scope/revision/operation ids,
initial state, actions and independent readbacks together. Preserve failed-run
logs before retrying corrected setup. Close owned workspaces, remove only the
fixture's local Git repository, stop the owned service/browser and restore the
test-store plugin settings. Retain unresolved operation identity for recovery.

## Coverage outside this focused update

Graph, qualification, spec/ask/dispatch and environment-provider plugins have
additional entry points beyond this panel. This guide does not replace their
feature-level verification. Canonical plugins now have explicit recipe owners in the inventory, including
repository operations and environment providers. An inventory fingerprint check
alone does not establish live coverage for those surfaces.
