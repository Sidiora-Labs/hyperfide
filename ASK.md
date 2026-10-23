kind: question

Should task 0.7 resolve the existing desktop identity fixture failures and supply identity_gate.py before release qualification?

Options:
- Recommended: task 0.7 fixes its desktop identity fixtures and supplies its identity gate before qualification.
- Authorize task 7.4 to modify the desktop fixtures outside the declared touches.

Blocked: the all-app test gate fails in desktop's electron-builder-config tests (stale executable identity expectations) and desktop-version-feed test (missing latest-mac.yml fixture); the full identity gate is absent. A desktop logger timeout also occurred under the concurrent run.

Finished anyway: platform installation, server/app/daemon builds, extension tests, version updates and real release packaging/smoke implementation. Release qualification continues; results will be appended here.

kind: question

Should task 1.1's owner update tests/integration/43_help.sh for the platform group that task added?

Options:
- Recommended: task 1.1's owner reconciles its help fixture before release qualification.
- Authorize task 7.4 to edit 43_help.sh outside its touches.

Blocked: CG="$PWD/cg" bash tests/integration/43_help.sh fails with AssertionError because the actual group list includes platform and the fixture's expected list omits it. The release check still runs the unchanged full integration suite.

Finished anyway: the binary builds as 2.2.0; the service typecheck/build and platform builds pass. Archive construction and smoke are being verified independently of this fixture.

kind: question

Should task 0.4 repair server startup with the default empty marketplace URL before release qualification?

Options:
- Recommended: task 0.4's owner repairs plugin-catalog-service.ts so disabled marketplaces do not schedule a refresh requiring a deleted row.
- Authorize task 7.4 to repair that file outside its touches.

Blocked: bash tests/hyperfide/cases/v22/7_4.sh builds all artifacts, verifies their contents and checksums, then the extracted server exits 1 in scheduleNextPeriodicRefresh/requireRow because its reserved marketplace row does not exist with the default empty HYPERFIDE_MARKETPLACE_URL. The smoke retains this real failure.

Finished anyway: all five tar archives and the VSIX build; every SHA256 checksum and archive-content check passes; release notes are generated per wave from done tasks into the output directory. The full strict C integration gate is running independently so its result is still collected.

Final release-specific checks:
- The latest 7_4.sh passes all archive-content checks, done-task release-note checks, version checks and SHA256 checks, then fails at the default server startup regression above.
- A separate diagnostic run with an explicit local marketplace URL boots the real extracted server, enrolls the real extracted daemon and passes both health checks. This exposed and verified the fix for packaging the daemon's required sibling CLI. The committed default smoke remains unchanged and continues to expose the default-startup failure.
- pnpm -C platform install --no-frozen-lockfile succeeds and leaves platform/pnpm-lock.yaml unchanged.
- Service check/build and extension tests pass. Every changed app's typecheck passes.
- The all-app test run completes with 26 successful Turbo tasks and failures in app, server, desktop and the plugin SDK dependency. App/server include stale removed-path and identity fixtures (task 0.7), assertions and timeouts: app has 6307 passing / 14 failing tests; server has 3592 passing / 20 failing tests. CLI, host-daemon, mobile, demo-server and ai-gateway suites pass. The dependency shared-declaration-emit test also times out in a targeted rerun with the original timeout.
- The first strict C release gate passes compilation, units and integrations through 17_session, then encounters conflicting inherited task aliases in 18_orchestrate. The release runner now clears its worker task aliases; the unchanged 18_orchestrate fixture passes with that isolation. The rerun passes 18_orchestrate, then fails at 19_acp.sh because it checks a removed extension module.
- identity_gate.py --changed cannot run because task 0.7 has not supplied that file (Python exits 2 with ENOENT).

Task 7.4 remains in_progress because its actual verify command does not pass. No qualification or publication was attempted.

Ownership correction (Ask 6): git blame identifies task 0.4 commit 41d8a63d36 as the source of the empty default marketplace URL. Ask 5 incorrectly named task 0.6; task 0.4 owns this startup repair.

The full strict C gate rerun passes compilation, units and integration fixtures through 18_orchestrate. It then fails in tests/integration/19_acp.sh with MODULE_NOT_FOUND for editors/vscode/acp.js. git ls-files confirms that module is no longer tracked; task 2.5 removed it in dbd94d117. Recommended: task 2.5's owner reconciles its ACP fixture (alternative: authorize 7.4 to edit it outside its touches). The independently reproduced 43_help.sh failure remains as well. No integration fixture was skipped.
