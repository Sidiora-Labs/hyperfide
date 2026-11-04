# Verifier and layout cases

SCM-024 runs the actual qualifier/checker positive and refusal protocol, closure input refusal checks, release input refusal checks, and resumable campaign execution tests. Its 50 assertions cover verifier conformance. Owned protocol fixtures establish those refusal boundaries; they do not stand in for product case receipts. The full release closure still requires every independent case and required variant.

SCM-025 invokes the current complete layout gate, consumes its real task 0.4–0.8 receipts, and requires the current source snapshot, original Git baseline/mapping, rollback lineage and layout-before-fleet-before-native dependency order. It remains blocked until that gate passes; retained older artifact receipts cannot satisfy a newer source snapshot.

Run `python3 tests/hyperfide/source-control/full_case/verifier_layout.py --case SCM-024` or `--case SCM-025`. Build canonical manifests with `verifier_manifest.py --case SCM-024 --native-source <shared-native.json> --output <manifest.json>` after the shared authenticated source capture includes the registration inputs. The release campaign runner additionally verifies every registered transitive source root against that same capture.
