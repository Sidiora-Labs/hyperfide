kind: permission

May this test-only follow-up also reconcile the existing bundled plugin ID reservation mismatch and investigate unrelated server test failures?

Options:
- Approve expanding scope to fix the server verification failures (recommended).
- Keep this follow-up limited to removing the case script's map dependency.

Blocked: passing the full 0_2.sh case and marking task 0.2 implemented. The server suite reports 13 failures across 9 files, including a reserved-ID expectation missing hyperfide-spec, timeouts, and timeline signal assertions. The latest instruction permits only the map dependency change.

Finished: replaced the deleted map with the canonical tracked-file identity gate and direct manifest/source assertions. Identity gate, direct assertions, platform build, frozen install, and workspace typecheck pass. The full case ran for real; no checks were weakened. The targeted native plugin-loading rerun passed all three tests without changing timeouts.
