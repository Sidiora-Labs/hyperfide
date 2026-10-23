# Desktop application

Status: **2026-09-05: 12 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Use a graphical macOS or Linux test host with the source desktop build. Follow
the main launch preflight and fresh-store marker, then use
`pnpm dev` and `pnpm exec turbo run dev --filter=@hyperfide/desktop` in separate
terminals. Confirm
that Electron and its owned runtime use this checkout's isolated store. Browser
automation against the web app cannot prove native menu, window, or update behavior.
Native actions need OS/Electron automation and inspected screenshots.

## Source

- `apps/desktop/src/main.ts`
- `apps/desktop/src/menu.ts`
- `apps/desktop/src/desktop-browser-view.ts`
- `apps/desktop/src/server-url-dialog.ts`
- `apps/desktop/src/desktop-auto-update.ts`

## Feature recipes

## Built-in browser CLI and SDK

Status: **not run**. These recipes extend the map without changing the dated
audit. They exercise Electron's built-in browser, not the browser-automation
plugin. A web-only session cannot verify them. Use the isolated source desktop
and matching source CLI described in [the main skill](../SKILL.md), a synthetic
thread, and a local HTTP fixture with known content and navigation links.

From the repository root, use `node apps/cli/dist/index.js browser --help` and
subcommand help. Discover the host with the source CLI's machine list, then run
`browser instances --host <id> --json` with that CLI prefix. Use returned IDs;
tab and lease commands require `--host`, `--instance`, `--generation`, and
`--thread`. Import commands omit `--thread`. Repeat the applicable operations
through SDK `experimental_desktopBrowsers`, including `subscribe` for watch.

Use an owned temporary directory and fresh output filenames. Connection files
contain credentials: never print or publish them, and run CDP on the browser
host. Capture only fixture pages. Cookie import requires explicitly authorized,
disposable source and destination profiles with synthetic cookies; never copy
the owner's signed-in profile.

The scanner records the dynamic command `${name} <tabId>` once; both `reveal`
and `close` still need execution. Source: `apps/cli/src/commands/browser.ts`,
`packages/sdk/src/areas/desktop-browsers.ts`,
`apps/server/src/routes/desktop-browsers.ts`,
`apps/desktop/src/desktop-browser-broker.ts`, and
`apps/desktop/src/desktop-browser-cdp.ts`.

Record each row separately as passed, failed, not run or blocked. Fixture tests
and source review are not live verification. Release leases, dispose SDK
subscriptions, stop watch/CDP, close created tabs, and remove only owned
credential files, captures and synthetic profiles after saving redacted evidence.

## Evidence and cleanup

Record each row and platform separately with the actual entry point, observed
state, persisted side effect, and evidence. Missing hardware/service access is
a prerequisite gap, not a pass. Stop only owned sessions/processes, restore
preferences, and remove only synthetic resources after evidence is preserved.

## Maintenance notes

- Before native recipes, check Accessibility automation and screen-capture availability without prompting or changing owner settings. If unavailable, record native-input rows blocked; Electron CDP renderer coverage does not prove native menu/window actions. Source: `apps/desktop/scripts/run-electron-dev.mjs:116; live native-access.txt`.
- The desktop dev command attaches to the running Vite app. For enabled Server & Daemon Logs and desktop-owned runtime lifetime tests, use a separately marked disposable standalone desktop runtime; record reuse-mode disabled log actions separately. Source: `apps/desktop/scripts/run-electron-dev.mjs:78; apps/desktop/src/main.ts:1335`.
- For a shared source dev app, Turbo-build @hyperfide/desktop, then run its standalone run-electron-dev.mjs from apps/desktop with Node22, an owned DISPLAY, isolated HYPERFIDE_DESKTOP_USER_DATA_DIR and HYPERFIDE_DESKTOP_ELECTRON_ARGS CDP port. It detects the existing Vite app and attaches without restarting shared server/daemon. Attach CDP by an existing target id; Electron does not support Target.createTarget. Source: `apps/desktop/scripts/run-electron-dev.mjs:72`.
