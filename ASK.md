kind: decision

Should the SDK export guard drop two tunnel ingress names that have no declaration, export or implementation in this checkout?

Options:
- Align the expected exports with the existing contract and explicitly assert the obsolete ingress names remain absent (recommended).
- Restore the missing ingress API from an authoritative specification.

Blocked: nothing; proceeded with the recommended contract alignment after the decision deadline passed.

Finished: package scopes and manifest names renamed, lockfile regenerated, frozen installation and workspace typecheck passed; fixing remaining SDK test failures.

kind: decision (Ask #5)

Should the five marketplace tests be aligned with the existing removal of the bundled official marketplace?

Options:
- Retain third-party coverage and assert the removed bundled marketplace is unavailable (recommended).
- Restore bundled marketplace behavior.

Blocked: nothing; proceeded on the recommendation after the decision deadline passed.

Finished: SDK and config tests pass; fixed public SDK classification in the host builder and stable plugin ID derivation for renamed package names.

Final evidence: `bash tests/hyperfide/cases/v22/0_2.sh` passed, including the scope assertion, frozen installation, all 99 workspace typechecks, and SDK/config/server tests. Supporting domain, plugin-build and provider-bridge-protocol suites also passed. Existing skipped tests remain unchanged.

The removal-aware updates also cover the catalog route fixtures, catalog counts, a shadowing fixture using an existing builtin, and host deletion without the retired hosted plugin. No hosted functionality was restored.

Task 0.2 is implemented; qualification and committing remain with the runner.
