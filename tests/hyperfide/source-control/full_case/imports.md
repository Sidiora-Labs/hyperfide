# Import and migration cases

`imports.py --case SCM-016` runs the native import/projection/contribution tests and a fresh read-only GitHub import. Set `HF_SOURCE_GITHUB_IMPORT_RECEIPT` to the retained receipt for an explicitly owned private canary. The driver verifies its current private owner, fetches the exact recorded Git identity, checks native bytes/modes/archive provenance, and verifies the remote ref remains unchanged. It never creates a repository or pushes a ref.

`imports.py --case SCM-017` runs two real Git histories through consolidation, kernel-enforced legacy isolation, a final delta, independent native acceptance, activation, and forward recovery. It uses an owned PostgreSQL server and a user/mount namespace. Its evidence describes that bounded two-project topology.

Both keep their detailed driver receipts below `build/source-control/full-case/<case>/` and emit the exact registered assertions. Build their canonical manifests with `import_manifest.py --case <case> --native-source <shared-native.json> --output <manifest.json>`; source identity remains the common release capture. SCM-016 also pins the supplied GitHub receipt as a data input. No migration of user repositories is performed by these cases.
