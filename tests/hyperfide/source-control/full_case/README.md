# Executable full-case journeys

`scm_023.py` executes one integrated source journey: signed fleet assignment, isolated worker edits, durable checkpoints, lost-response submission reconciliation, replacement fencing, independent qualification, native acceptance, selected-source dependent execution, signed CLI reads, actual browser navigation at desktop/tablet/mobile sizes, UI publication, and independent Git readback.

Run the owned profile with `python3 tests/hyperfide/source-control/full_case/scm_023.py`. It requires the same PostgreSQL 18 and Node 24 toolchain as the native integration cases, an already built control service and CLI, and Chromium at the product browser fixture's configured path. It allocates only owned local resources and retains its evidence under `build/source-control/full-case/SCM-023/`.

The registration is `case:hyperfide-source-control/SCM-023/owned-api-cli-ui`. It does not replace the required `api-cli-ui` live-fleet variant. The receipt explicitly identifies its local worker and local Git profile; it does not assert hosted-provider behavior, 72-hour endurance, real S3 availability, or production release acceptance.

For canonical qualification, provide actual native source capture and readiness evidence with the exact registered assertion inventory, then run:

```sh
python3 tests/hyperfide/source-control/full_case/manifest.py --native-source <capture.json> --output <campaign.json>
python3 tests/hyperfide/qualify.py --registry tests/hyperfide/source-control/registry.json --manifest <campaign.json> --case SCM-023
```

The manifest command verifies the supplied native capture and pins the executable inputs. It does not manufacture native revisions, authority epochs, object readiness, or source receipts. Missing native inputs block manifest creation. Release closure still requires every canonical case and its declared variants.

The journey also preserves a genuine capture of its accepted test data through authenticated native API reads, including canonical object envelopes and toolchain hashes. That data snapshot is evidence of the exercised source state. The campaign's supplied native implementation capture must identify the code being qualified; the data snapshot does not substitute for it.

After the full-case registrations and implementation freeze, `prepare_capture.py --all-full` captures the union of their reviewed source files and source-root inventories into one native implementation snapshot. It checks the registry and file inventory again after capture. Reuse its `native.json` for every case: manifest builders may change the declared assertion-inventory hash for their own ordered assertions, while scope, revision, root, authority epoch and policy remain identical. The shared capture includes actual Node, Python, Git and Chromium binary pins.
