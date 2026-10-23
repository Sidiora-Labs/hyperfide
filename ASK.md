kind: permission

May I add the task 1.6 CLI runner to the provider-literal allowlist so the unchanged scripts regression suite passes?

Options:
- Recommended: approve a two-reference entry for `plugins/hyperfide-dispatch/src/dispatcher/runners.ts`, documenting that it selects CLI executables.
- Defer the repair to task 1.6 and leave verification blocked.

Blocked: full task 0.5 verification. Clean HEAD reproduces two failures with `pnpm -C platform/packages/scripts exec vitest run test/provider-literal-ratchet.test.mjs`: `Provider-literal ratchet FAILED`, `+ plugins/hyperfide-dispatch/src/dispatcher/runners.ts: 2`.

Finished independently: telemetry scan, all 12 typecheck tasks, obsolete bundled-task expectation removal, server timeout repairs, identity fixture repairs (version-bump and plugin-fork tests pass), and launcher process-test timing repair (31/31 tests pass). Full verification was run once and failed on launcher timeouts; the second run is reserved until the blocking repairs are supplied. The scripts stage independently reproduced the baseline failures described here. No task completion is claimed.

Control-plane Ask: 2.

kind: permission

May I repair task 1.5's missing bundled preparation for the registered hyperfide-asks plugin?

Options:
- Add the real preparation script and workspace builder dependency, and reinstall.
- Recommended: have task 1.5 supply the build repair before 0.5 verification.

Blocked: bundled-plugin-tasks.test.mjs and full verification. The registered plugin has no prepare:bundled script, while bundled-plugins/build.ts requires its .bundled-runtime directory. Clean HEAD reproduces the bundled-task test failure; after accounting for qualify/graph custom builders, the missing asks builder is the next failure. No test was skipped or weakened.

Control-plane Ask: 3.

Final independent validation: install-machine-script.test.ts passes 53/53; timeline-in-turn-window.test.ts passes; managed-json-process.test.ts passes 31/31; bump-version.test.mjs and plugin-forks.test.mjs pass. Refreshed touched-package typechecks pass (6/6 tasks). Shell/JavaScript syntax and git diff --check pass. The broader server run was stopped after the separate scripts stage exposed the blocking baseline failures; this is not a full verification pass.
