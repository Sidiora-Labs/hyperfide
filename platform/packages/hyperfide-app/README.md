<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="Hyperfide" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# Hyperfide

[![npm version](https://img.shields.io/npm/v/hyperfide-app.svg)](https://www.npmjs.com/package/hyperfide-app)

Hyperfide is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

This package provides the `npx hyperfide-app` launcher, bundled `Hyperfide` CLI entry, and
Node SDK export. Every surface — the web app, CLI, and HTTP API — is a
first-class way to drive hyperfide. Work runs in threads you can follow live, steer at
any point, or hand off to another agent.

> Note: Hyperfide is in active development. Workflows and surfaces are still evolving.

## Quick Start

Hyperfide runs from npm and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js 22.19, 24, or 26.
- Git.
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), Cursor via ACP, [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), or another ACP-compatible agent.

If you already use one of these providers, Hyperfide will pick up your existing
credentials. If you use multiple providers, you can mix and match per task.

### Supported host environments

- macOS
- Linux

<details>
<summary>Windows via Ubuntu on WSL2</summary>

Run all `Hyperfide` commands inside WSL2, install Node.js, Git, and your provider CLIs
inside that WSL2 distro, and use Linux-style paths such as `/home/me/repo` or
`/mnt/c/Users/me/repo`.

Inside WSL2, use Linux paths rather than drive-letter or UNC paths. Repos
inside the WSL filesystem are recommended;
`/mnt/c/...` is intentionally supported so you can keep an existing Windows
checkout, but it is slower and less reliable for file watching.

</details>

### Install and run

```bash
npx hyperfide-app@latest
```

Then open: `http://localhost:38886`

To opt into the automated nightly channel:

```bash
npx hyperfide-app@nightly
```

Nightly versions are built from `main` and may be unstable. The `nightly`
dist-tag moves independently of the stable `latest` tag.

npm 12 and later block dependency install scripts by default. Hyperfide needs those
scripts to build its native add-ons (`better-sqlite3`, `node-pty`,
`@parcel/watcher`). Without them Hyperfide stops at startup with
`Could not locate the bindings file`. If your npm version is 12 or later, allow
the scripts for the install:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher hyperfide-app@latest
```

Or set the policy once for all global installs:

```bash
npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user
```

`npx hyperfide-app@latest` downloads the published `hyperfide-app` package, starts the server and
local host daemon, and serves the web app. It stores hyperfide-managed state under
`~/.hyperfide/` by default. If either managed child process exits unexpectedly, the
launcher restarts that child without stopping the other one. Press `Ctrl+C` in
the terminal to stop both processes and exit with status `0`.

If another live Hyperfide owns the runtime record for the same data directory and a
healthy server answers on the configured local address, startup exits with
status `1` without starting either child process. The existing instance keeps
running. A runtime record without a healthy server does not prevent startup.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the data directory, keeping the five newest files per service. Output that
bypasses the logger, such as startup errors and crashes, goes directly to
`logs/server-stdio.log` and `logs/host-daemon-stdio.log`. These files append
across restarts; when one is over 10 MB as a service starts, it is renamed to
`-stdio.1.log`, replacing the previous one. The launcher prints status and log
locations without forwarding service output to the terminal, so a stalled
terminal cannot block service logging. To follow everything with the default
data directory:

```bash
tail -F ~/.hyperfide/logs/*.log
```

Launcher status output is plain when stdout is redirected, including in CI.
Set `FORCE_COLOR=1` to request color or `NO_COLOR=1` to disable it; `NO_COLOR`
takes precedence. In-place progress updates require a stdout TTY.

The same output capture applies to `hyperfide-server` and `hyperfide-host-daemon`.

To stop a Hyperfide that runs in another terminal or in the background:

```bash
npx hyperfide-app stop
```

`stop` reads `hyperfide-app-runtime.json` from the data directory, confirms that the
recorded process really is that launcher, then stops it. Pass `--data-dir` when
the Hyperfide you want to stop does not use the default `~/.hyperfide/`.

### The `Hyperfide` command

To control Hyperfide from outside Hyperfide, open **Settings → General → Command line** and
choose **Install** next to **Hyperfide CLI**. Threads in Hyperfide already have `Hyperfide`; this
is for your own terminals, scripts, and agents running outside Hyperfide, such as
Claude Code or Codex. Hyperfide links a launcher from `~/.hyperfide/bin/hyperfide` into a folder on
your PATH (`~/.local/bin` on Linux; `/opt/homebrew/bin`, `/usr/local/bin`, or
`~/.local/bin` on macOS). On Windows it adds `~/.hyperfide/bin` to your user PATH;
open a new terminal afterwards. **Remove** takes it off again. Hyperfide leaves any
other `Hyperfide` you already have in place.

From a terminal, before `Hyperfide` is on your PATH:

```bash
npx --package hyperfide-app Hyperfide settings cli-command install
```

### Updating from the app

When Hyperfide has an update, Settings → Updates shows an **Update** button (or run
`Hyperfide updates app apply`). Hyperfide downloads the new version into
`~/.hyperfide/app-versions/`, restarts into it, and reconnects the page. Hyperfide does not
roll back: if the new version fails to start, run a newer release
(`npx hyperfide-app@latest`) or fix the cause. Later `npx hyperfide-app` runs use the newer
installed version; pass `--bundled` to run the copy npx downloaded instead.
Start Hyperfide with `--no-in-app-updates` to turn in-app updates off.

After the server moves to another machine, the old data directory keeps
`server-moved.json`. `hyperfide-app` there starts no server: it runs this computer's
host daemon against the new server address in `config.json`, restarting it when
it exits, and answers the old server port. API requests get `410 server_moved`
with the new address; browser pages redirect to it for a direct address or link
to it for hyperfide-platform connect. While a move back to this computer is in progress
(`server-import.json`), it frees that port for the incoming server. When
`server-moved.json` goes away, after that move completes or `hyperfide-platform server unlock`,
it starts the server and co-located daemon again. `hyperfide-server` exits with status
`3` instead of starting, except for the incoming server of a move back.

From the app, add or open a project, start a thread, and choose the provider
you want that thread to use.

## CLI

The package also exposes the `Hyperfide` CLI for an already-running hyperfide-platform server:

```bash
npx --package hyperfide-app hyperfide-platform --help
```

The CLI uses the same `HYPERFIDE_SERVER_URL` and hyperfide-platform config resolution as the SDK. When
unset, it targets the default local packaged server at
`http://127.0.0.1:38886`.

## Scripting with the SDK

The package also exposes a Node SDK for scripts that drive an already-running
hyperfide-platform server:

```ts
import { HyperfideSdk } from "hyperfide-app";

const Hyperfide = new HyperfideSdk();
const thread = await hyperfide.threads.spawn({
  projectId: "proj_personal",
  environment: { type: "host", workspace: { type: "personal" } },
  prompt: "Summarize my active Hyperfide work.",
});
await hyperfide.threads.wait({ threadId: String(thread.id), status: "idle" });
console.log(await hyperfide.threads.output({ threadId: String(thread.id) }));
```

`new HyperfideSdk()` uses the same `HYPERFIDE_SERVER_URL` and hyperfide-platform config resolution as the
CLI. Pass `new HyperfideSdk({ baseUrl: "http://host:38886" })` for remote or test
targets (see the remote-access note below). Scripts launched by Hyperfide already receive `HYPERFIDE_SERVER_URL` and
`HYPERFIDE_THREAD_ID` in their environment.

## Provider Credentials

Hyperfide uses whichever providers you have configured. Common providers:

| Provider       | Setup                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`        | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                                                                                           |
| `claude-code`  | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                                                                                            |
| `cursor`       | Install [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent`) and authenticate per Cursor's docs.                                                                                                                       |
| `pi`           | Install [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) with `npm install -g @earendil-works/pi-coding-agent` (0.84.0 or newer) and authenticate per its docs; HYPERFIDE can run the install from Settings. |
| `opencode`     | Install [opencode](https://opencode.ai/) and authenticate per its docs.                                                                                                                                                         |
| `grok`         | Install [Grok Build](https://docs.x.ai/build/overview) and authenticate with `grok login` or `XAI_API_KEY`.                                                                                                                     |
| `hermes-agent` | Install [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation), configure credentials with `hermes model`, then verify ACP with `hermes acp --check`.                                          |

HYPERFIDE indexes the documented native skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. It includes user roots,
project roots, and compatibility roots such as `.agents/skills`. These skills
appear in the selected provider's `/` command menu. The Skills page and
`Hyperfide skill list` show native skills for Claude Code, Codex, and Cursor. HYPERFIDE also
reads configured Pi, omp, Grok, and Hermes skill directories, plus enabled
provider plugin skills.

HYPERFIDE reads Pi's global `~/.pi/agent` files and each workspace's `.pi` files.
This includes settings, credentials, models, packages, extensions, skills,
prompts, themes, and context files. Pi extensions can add models and tools.
HYPERFIDE loads project resources only after Pi's saved or global trust policy approves
the workspace. An unresolved `ask` decision stays untrusted because HYPERFIDE has no Pi
trust prompt.
You can still use the Pi CLI and `/login` to create this configuration.

Custom ACP agents are configured through the ACP providers plugin's
`customAgents` setting: `hyperfide-platform plugin config provider-acp set customAgents
'[...]'`. See the configuration docs for the optional `modelCli` and
`reasoningCli` or `nativeReasoning` reasoning settings. The optional
`nativeSkillRoots` field adds provider-native skills to the composer. Its
`user` paths resolve from the target host home directory. Its `project` paths
resolve from the selected workspace.
Top-level `sharedSkillRoots` uses the same `user` and `project` path format.
HYPERFIDE lists these sources as read-only skills. HYPERFIDE injects them into Codex, Claude,
Pi, and ACP threads. This permits one physical skill collection for HYPERFIDE and a
standalone provider CLI.

## Configuration

Use `hyperfide-app config` for persistent non-secret package settings under
`~/.hyperfide/config.json`:

```bash
npx hyperfide-app config set HYPERFIDE_APP_URL https://<machine>.<tailnet>.ts.net
npx hyperfide-app config list
npx hyperfide-app config refresh
```

For remote access, use hyperfide-platform connect or publish the default loopback listener with
Tailscale Serve. Direct tailnet or LAN access to port `38886` requires the
explicit, security-sensitive `--server-bind-host 0.0.0.0` compatibility option;
see the multiple-devices guide.

Use `hyperfide-app client ssh-target` to configure local editor opens for remote
Hyperfide servers under `~/.hyperfide/client.json`. The target is the value that works after
`ssh`, such as `devbox` or `user@devbox`:

```bash
npx hyperfide-app client ssh-target set https://hyperfide.example.test devbox --host-id host_abc
npx hyperfide-app client ssh-target list
```

Use `hyperfide-app env` for provider credentials under `~/.hyperfide/env.json`:

```bash
npx hyperfide-app env set OPENAI_API_KEY <key>
npx hyperfide-app env list
npx hyperfide-app env unset OPENAI_API_KEY
```

`env list` redacts all values. Config and env writes ask a running local hyperfide-platform
server to reload; if Hyperfide is stopped, the values apply on the next start.

For all config keys, precedence, startup flags, and source-development `.env`
behavior, see the
[configuration docs](https://github.com/hyperfide/hyperfide/blob/main/docs/configuration.md).

## Further Reading

- [Main README](https://github.com/hyperfide/hyperfide#readme)
- [Platform support](https://github.com/hyperfide/hyperfide/blob/main/docs/platform-support.md)
- [Configuration](https://github.com/hyperfide/hyperfide/blob/main/docs/configuration.md)
- [Using Hyperfide on multiple devices](https://github.com/hyperfide/hyperfide/blob/main/docs/multiple-devices.md)
- [Worktree setup and teardown scripts](https://github.com/hyperfide/hyperfide/blob/main/docs/worktrees.md)
