# Workspace qualification

`workspaces.py --case SCM-010 --full` runs the native sparse host suite against an owned PostgreSQL service and configured S3 storage. It verifies cold and warm materialization, executable and symlink types, private writable copies, rejected omitted inputs and foreign descriptors, cache integrity, overflow reconciliation, checkpoint replay and independent source-object readback.

`workspaces.py --case SCM-011 --full` also runs the real `linux-fuse7-source-v1` mount suite. It requires `/dev/fuse`, the admitted mount capability and pinned host executables. It verifies demand hydration, multi-page directory enumeration, rename and deletion, compiler reads, explicit unsupported mmap behavior, local locks, pinned open handles, dirty budgets, authority loss, cancellation and restart recovery. This registration covers the declared Linux profile.

Both drivers retain task receipts and exact owned S3 placement inventories. They create isolated database resources and remove their owned local runtime state. Storage credentials are read from the private environment or `.env` by the service fixture.

For final canonical qualification, use `prepare_capture.py --all-full` after the shared source freeze, then construct each manifest from that shared `native_source_path`. The case-specific capture wrapper is available for isolated runs:

```sh
python3 tests/hyperfide/source-control/full_case/workspace_capture.py --case SCM-011
python3 tests/hyperfide/source-control/full_case/workspace_manifest.py --case SCM-011 --full --native-source <native.json> --output <campaign.json>
python3 tests/hyperfide/qualify.py --registry tests/hyperfide/source-control/registry.json --manifest <campaign.json> --case SCM-011
```

Use `SCM-010` for the sparse variant. The native capture verifies the actual API revision, object envelopes, input file hashes and toolchain binaries. A missing S3 backend or unavailable FUSE host prevents qualification.

The `/full` registrations add server-side scope widening with dirty host files and explicit refresh, plus refusal of unavailable host executable capability. Their receipts are stored under each case’s `full/` directory; the descriptive-profile receipts remain separate.
