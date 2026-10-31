# Platform testing

Use Node 24 and pnpm 9.15 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

The unit gate runs the workspace's Vitest configurations, including the fake
provider integration suite. Loopback servers and child processes are required.
UI component tests use a DOM emulator; desktop unit tests do not launch a window.
Desktop native-module validation executes Electron with `ELECTRON_RUN_AS_NODE=1`
and requires Electron's Linux runtime shared libraries even without a display.
Turbo runs one test package at a time and Vitest defaults to two workers per
project, so independent suites do not exhaust the sandbox's CPU and memory.
Set `VITEST_MAX_WORKERS` to adjust the per-package worker count.

The following checks need external capabilities and have separate configurations
or explicit availability guards; they are not prerequisites for the unit gate:

| Check | Configuration or command | Reason |
| --- | --- | --- |
| Real provider integration | `tests/integration/vitest.real-provider.config.ts`, `pnpm test:integration` | Requires installed providers, credentials and external provider network access. The default integration configuration selects fake providers and local fixtures. |
| Plugin toolchain download | `packages/plugin-build/src/toolchain.test.ts`, `HYPERFIDE_TEST_TOOLCHAIN_FETCH=1` | The download test is opt-in because it fetches build tools from the npm registry; the default suite tests the locally installed toolchain. |
| Desktop browser smoke tests | `apps/desktop` scripts `smoke:browser-address`, `smoke:browser-cdp`, `smoke:browser-broker` | Requires an Electron display and browser session; separate smoke commands. |
| Desktop native-module validation | `apps/desktop/test/electron-builder-config.test.ts` | Probes Electron at runtime and skips when it cannot start, such as when GTK, X11, NSS or audio libraries are missing. When available, the full SQLite validation runs. |
| Packaged desktop lifecycle | `apps/desktop` scripts `smoke:packaged`, `smoke:packaged-npm`, `smoke:appimage-lifecycle` | Requires packaged artifacts and an interactive desktop; separate smoke commands. |
| Mobile end to end flows | `apps/mobile` scripts `e2e:android`, `e2e:ios` | Requires a device or emulator; the unit configuration selects `src/**/*.test.ts`. |
| Provider corpus replay | `apps/server/test/provider-corpus` availability guards | Skips when the optional local recording corpus is absent; no recording is downloaded by tests. |
| macOS shell integration | `apps/desktop/test/desktop-shell-path-timeout.test.ts` | Its platform guard skips on non-macOS hosts. Other OS-specific process and filesystem cases use their own platform guards. |
| Watcher recovery benchmark | `packages/host-watcher/test/root-recovery-benchmark.test.ts` | Opt-in performance measurement under `HYPERFIDE_WATCHER_ROOT_RECOVERY_BENCHMARK=1`. |
| Sidebar benchmark | `apps/app` script `bench` | Opt-in performance measurement under `HYPERFIDE_SIDEBAR_BENCH=1`. |
| Composer paste benchmark | `plugins/composer/src/editor/prompt-paste-performance.test.ts` | Opt-in performance measurement under `PROMPTBOX_PERF=1`. |

Former CI helper scripts and their tests were removed because they depended on
workflow files that are not part of this platform. Repository CI is owned by the
root workflow, rather than a second workflow tree inside the platform.
