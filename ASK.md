kind: permission

May I add the standard bundled preparation script and builder dependency to the registered machine-railway plugin?

Options:
- Recommended: approve the same real builder repair used for hyperfide-asks, then regenerate the lockfile with pnpm.
- Defer the machine-railway repair to its owner.

Blocked: bundled-plugin-tasks.test.mjs and full 0_5.sh verification. The tracked clean HEAD manifest for platform/plugins/machine-railway/package.json has no prepare:bundled script, although builtin-registry.ts includes it in OFFICIAL_PLUGINS. The focused bundled-task test fails with expected undefined to be 'hyperfide-plugin-build prepare-bundled'. This is a behavioral change outside task touches.

Finished independently: approved provider-literal allowlist and hyperfide-asks builder repair; pnpm regenerated the lockfile; telemetry scan and all typechecks pass; Inbox tests pass 21/21. First full verification hit SDK/launcher timeouts, and both isolated test files pass. Retaining the documented public SDK lint exception is required by the concrete bb/forkable-plugin-imports failure in platform/plugins/automations/app.tsx:16 and three plugin-forks regression tests. Continuing server verification without weakening tests.

kind: permission

May the provider graph worker-injection build boundary be repaired here, or should its owning task supply the fix?

Options:
- Recommended: have the owning task repair the provider-to-graph build boundary.
- Approve a production repair preserving the private-workspace import guard.

Blocked: provider artifact builds and reliable full verification. Clean HEAD reproduction used git stash push -u, then `pnpm -C platform/packages/plugin-build exec vitest run src/builtin-host-artifacts.test.ts src/zod-locale-stub.test.ts --maxWorkers=2`, then git stash pop. Both provider-claude-code and provider-codex artifact cases fail with `src/worker-injection.ts:5:31: Could not resolve "../../hyperfide-graph/src/worker-injection/worker-injection.js"`. The Zod case passes. Server verification also reports `reject-private-bb-host-imports`: host entries cannot import private workspace package `@hyperfide/hyperfide-graph`. This is a production cross-plugin boundary defect, outside task touches and the identity grant.

Finished independently: the two approved follow-up repairs, Inbox typecheck/tests (21 tests), telemetry scan, all verification typechecks, isolated SDK and launcher tests, and provider-literal ratchet (24 tests). The SDK lint exception has a comment and concrete evidence: reverting it fails `bb/forkable-plugin-imports` in `platform/plugins/automations/app.tsx:16`; restoring it clears that error. The broad server run was stopped after documenting the blockers (exit 130); it is not a pass. No guard or test was weakened. No second full 0_5.sh run has been used.

Control-plane Asks: 4 (Railway builder) and 5 (provider graph boundary).


Final independent repair: clean HEAD reproduced `builtin-plugins.test.ts > keeps official plugins bundled but out of the auto-install builtins` with the expected list missing machine-railway and machine-blaxel. Added those two entries under the approved small test-only baseline repair grant. The complete file now passes: Test Files 1 passed (1), Tests 28 passed (28). `git diff --check` passes. Task remains blocked; one full 0_5.sh run has been used and no full verification pass is claimed. Changes are left for the runner as instructed.

Required runner commit explanation: retain the public SDK exemption because reverting it fails `bb/forkable-plugin-imports` in `platform/plugins/automations/app.tsx:16` (and three plugin-forks regression cases). The rule still rejects internal SDK imports. The comment in oxlint-plugin.mjs now documents the reason. The hyperfide-asks builder repair fixes a task 1.5 defect here; pnpm regenerated the lockfile. The builder executable was renamed to match its existing manifest under the identity-only grant.
