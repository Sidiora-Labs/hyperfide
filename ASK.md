kind: permission

Can task 0.3 verification run in a sandbox that permits localhost socket binding?

Options:
- Recommended: allow localhost sockets so the required real HTTP and WebSocket tests can run.
- Keep the sandbox restricted and leave qualification pending.

Blocked: the required daemon and CLI tests cannot bind local servers; a minimal Node server listening on 127.0.0.1 fails with EPERM. This session uses approval policy never, so command escalation is unavailable. The permission Ask was submitted through the codify MCP tool.

Finished anyway: environment and data-directory renaming, migration implementation and regression tests, CLI identity and launcher changes, and a real verification script. Static checks and fixes continue.

kind: permission

Can this worker receive write access to .git to create the required task 0.3 commit?

Options:
- Recommended: allow .git writes for the required single plain commit.
- Keep .git read-only and return uncommitted changes.

Blocked: git add cannot create .git/index.lock because the filesystem is read-only. Codify permission Ask #2 records this blocker; Ask #1 records the localhost restriction.

Finished anyway: the CLI build passes. Remaining static checks and regression fixes continue. The task status stays pending until the required verification passes.

Additional paths changed to keep config consumers, launcher behavior, CLI guide output, and test fixtures consistent:

- platform/apps/app/vite.dev.config.ts
- platform/apps/app/vitest.config.ts
- platform/apps/desktop/test/bb-process.test.ts
- platform/apps/desktop/test/desktop-auto-update.test.ts
- platform/apps/desktop/test/desktop-browser-broker-client.test.ts
- platform/apps/desktop/test/desktop-browser-main-ipc.test.ts
- platform/apps/desktop/test/desktop-browser-view-manager.test.ts
- platform/apps/desktop/test/desktop-clipboard.test.ts
- platform/apps/desktop/test/desktop-find-view.test.ts
- platform/apps/desktop/test/desktop-version-feed.test.ts
- platform/apps/desktop/test/desktop-window-factory.test.ts
- platform/apps/desktop/test/desktop-window-focus.test.ts
- platform/apps/desktop/test/electron-builder-config.test.ts
- platform/apps/desktop/test/electron-builder-windows-config.test.ts
- platform/apps/desktop/test/existing-server-dialog.test.ts
- platform/apps/desktop/test/fixtures/browser-cdp-smoke.ts
- platform/apps/desktop/test/fixtures/startup-retry-smoke.cjs
- platform/apps/desktop/test/preload-browser-api.test.ts
- platform/apps/desktop/test/preload-build.test.ts
- platform/apps/desktop/test/server-choice-ipc.test.ts
- platform/apps/desktop/test/server-probe.test.ts
- platform/apps/server/test/app/install-machine-script.test.ts
- platform/apps/server/test/app/install-machine-windows.test.ts
- platform/apps/server/test/app/startup-diagnostics.test.ts
- platform/apps/server/test/helpers/commands.ts
- platform/apps/server/test/helpers/server-move.ts
- platform/apps/server/test/host-join-enroll.test.ts
- platform/apps/server/test/provider-corpus/corpus-harness.ts
- platform/apps/server/test/provider-corpus/row-diff-classes.ts
- platform/apps/server/test/provider-corpus/row-snapshots.test.ts
- platform/apps/server/test/provider-corpus/timeline-pagination-correctness.test.ts
- platform/apps/server/test/provider-corpus/timeline-perf.test.ts
- platform/apps/server/test/providers/echo-provider-canary.test.ts
- platform/apps/server/test/providers/plugin-provider-registration.test.ts
- platform/apps/server/test/public/public-host-management.test.ts
- platform/apps/server/test/public/public-project-skills.test.ts
- platform/apps/server/test/public/public-provider-installations.test.ts
- platform/apps/server/test/server-move/checks.test.ts
- platform/apps/server/test/server-move/coordinator.test.ts
- platform/apps/server/test/server-move/imported-daemon-sessions.test.ts
- platform/apps/server/test/server-move/pending-boot.test.ts
- platform/apps/server/test/server-move/routes.test.ts
- platform/apps/server/test/server-move/run-state.test.ts
- platform/apps/server/test/server-move/switch.test.ts
- platform/apps/server/test/services/machines/server-access.test.ts
- platform/apps/server/test/services/plugins/builtin-plugins.test.ts
- platform/apps/server/test/services/plugins/first-party-provider-plugins.test.ts
- platform/apps/server/test/services/plugins/plugin-authoring-docs.test.ts
- platform/apps/server/test/services/plugins/plugin-collection-manifest.test.ts
- platform/apps/server/test/services/plugins/plugin-install.test.ts
- platform/apps/server/test/services/telemetry.test.ts
- platform/apps/server/test/skills/injected-skills.test.ts
- platform/apps/server/test/skills/skill-listing.test.ts
- platform/apps/server/test/system/bb-app-managed-config.test.ts
- platform/apps/server/test/system/cli-command.test.ts
- platform/apps/server/test/threads/environment-providers.test.ts
- platform/apps/server/test/threads/thread-checkpoint-identity.test.ts
- platform/apps/server/test/threads/thread-runtime-config.test.ts
- platform/apps/server/test/threads/workspace-path-claims.test.ts
- platform/packages/bb-app/src/app-update/source-checkout.ts
- platform/packages/bb-app/src/cli-launcher.ts
- platform/packages/bb-app/src/launcher.ts
- platform/packages/bb-app/test/cli-launcher.test.ts
- platform/packages/bb-app/test/fixtures/machine-enrollment-process.mjs
- platform/packages/bb-app/test/fixtures/managed-json-observer.cjs
- platform/packages/bb-app/test/host-daemon-startup.test.mjs
- platform/packages/bb-app/test/index.test.ts
- platform/packages/bb-app/test/managed-json-process.test.ts
- platform/packages/bb-app/test/moved-mode.test.ts
- platform/packages/bb-app/test/server-health-identity.test.ts
- platform/packages/client-core/src/panel/fixed-panel-tabs-state.ts
- platform/packages/desktop-contract/src/browser.ts
- platform/packages/desktop-contract/src/find.ts
- platform/packages/desktop-contract/src/info.ts
- platform/packages/desktop-contract/src/version-feed.ts
- platform/packages/desktop-contract/test/browser.test.ts
- platform/packages/domain/src/plugin-cli.ts
- platform/packages/logger/src/index.ts
- platform/packages/plugin-sdk/src/internal/host-policy.ts
- platform/packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts
- platform/packages/sdk/src/node.ts
- platform/packages/sdk/src/response.ts
- platform/packages/sdk/test/response.test.ts
- platform/packages/templates/src/templates/agent-thread-message.md
- platform/packages/templates/src/templates/bb-guide-agent-configuration.md
- platform/packages/templates/src/templates/bb-guide-browser.md
- platform/packages/templates/src/templates/bb-guide-customization.md
- platform/packages/templates/src/templates/bb-guide-environments.md
- platform/packages/templates/src/templates/bb-guide-json.md
- platform/packages/templates/src/templates/bb-guide-machines.md
- platform/packages/templates/src/templates/bb-guide-overview.md
- platform/packages/templates/src/templates/bb-guide-plugins.md
- platform/packages/templates/src/templates/bb-guide-projects.md
- platform/packages/templates/src/templates/bb-guide-providers.md
- platform/packages/templates/src/templates/bb-guide-terminals.md
- platform/packages/templates/src/templates/bb-guide-thread-inspection.md
- platform/packages/templates/src/templates/bb-guide-thread-lifecycle.md
- platform/packages/templates/src/templates/bb-guide-thread-messaging.md
- platform/packages/templates/src/templates/bb-guide-threads.md
- platform/packages/templates/src/templates/generate-commit-message.md
- platform/packages/templates/src/templates/generate-thread-metadata.md
- platform/packages/templates/src/templates/system-message-child-thread-needs-attention.md
- platform/packages/templates/src/templates/system-message-child-thread-outcome-batch.md
- platform/packages/templates/src/templates/system-message-environment-directory-updated.md
- platform/packages/templates/src/templates/system-message-thread-ownership-assigned.md
- platform/packages/templates/src/templates/system-message-thread-ownership-removed.md
- platform/scripts/bb-cloud-dev.mjs
- platform/scripts/build-official-plugins.mjs
- platform/scripts/bump-plugin-sdk.mjs
- platform/scripts/bump-version.mjs
- platform/scripts/check-plugin-forks.mjs
- platform/scripts/check-provider-literal-ratchet.mjs
- platform/scripts/ensure-native-modules.mjs
- platform/scripts/prepare-nightly-version.mjs
- platform/scripts/provider-corpus/snapshot-rows.sh
- platform/scripts/provider-recordings/convert-claude-transcripts-sample.sh
- platform/scripts/provider-recordings/package-cells.mjs
- platform/scripts/provider-recordings/redact.mjs
- platform/scripts/start-bb.mjs

Final verification evidence:
- Typechecks passed across the affected application, contract, config, and dependency packages; the packaged launcher also passed its typecheck.
- The CLI Turbo build passed and node platform/apps/cli/bin/hyperfide-platform --help exited 0.
- Three migration regression tests, 30 focused CLI command/guide tests, and 11 CLI installation tests passed.
- The required 0_3.sh identity scan passed, but its full test command failed: subprocess tests time out or fail with spawnSync EPERM and localhost tests fail with listen EPERM. No tests were weakened or skipped to obtain a pass.
- Dependency installation with --no-frozen-lockfile succeeded; the lockfile remained unchanged.
- Git staging failed because .git is read-only. No commit was created, and task 0.3 remains pending in the spec. Codify work closure records the criterion as unverified.
