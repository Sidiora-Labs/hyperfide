---
kind: instruction
title: hyperfide-platform Guide — Plugins
summary: Command reference for installing, configuring, and running hyperfide-platform plugins, a summary of the bundled plugins, and the plugin authoring loop.
intent: Provide complete plugin management documentation, route each bundled plugin to its own skill, and route plugin authors to the bb-plugin-authoring skill.
editingNotes: Keep flags accurate against the CLI implementation (apps/cli/src/commands/plugin.ts, apps/cli/src/commands/marketplace.ts) and the server plugin service; a CLI test asserts every `hyperfide-platform plugin` and `hyperfide-platform marketplace` subcommand and flag appears in this chapter. Each bundled plugin gets a two-to-three-line summary here; its manual lives in the plugin's own skill. The full authoring reference is the bb-plugin-authoring builtin skill.
---
Plugin commands

A hyperfide-platform plugin is a TypeScript package that extends hyperfide-platform with server code, an
optional entry that runs on enrolled hosts, UI, agent skills and tools, and
`hyperfide-platform` CLI subcommands. Plugins are full-trust code.

Builtin plugins (`builtin:<name>`) ship with hyperfide-platform and install automatically.
Official store plugins ship with the app and install on request; third-party
plugins come from marketplaces, Git, npm, or a local path. Plugin state lives
under `<bb-data-dir>/plugins/<id>/` (SQLite database, secrets, logs).

  hyperfide-platform plugin search <query>       Search the store: the bundled official
                                 plugins plus every registered marketplace.
                                 Matches id, name, description, category, or
                                 tag; status shows installed, compatible,
                                 requires newer bb, or `id in use by <source>`
  hyperfide-platform plugin install <entry>      Install an official plugin by name (docs,
                                 memory, tasks, github, ...),
                                 <entry-id>@<marketplace>, a Git repository
                                 URL, a local path, builtin:<name>,
                                 git:<url>[@<ref|semver-range>], or
                                 npm:<package>[@<version|tag|range>].
                                 Installs ask for confirmation; --yes skips it.
                                 --subdirectory <path> or --plugin <name>
                                 selects one plugin of a multi-plugin
                                 repository; --tag-prefix <prefix> scopes a
                                 git: semver range. Installing a local path
                                 for an id already installed from another
                                 path moves it and keeps its settings.
                                 Installs run one at a time as server jobs
                                 that continue if the CLI or app disconnects;
                                 a repeat request joins the active job.
                                 --no-wait starts the job and prints its id
  hyperfide-platform plugin install-jobs         List queued, running, and recently finished
                                 installs (--json for the jobs)
  hyperfide-platform plugin cancel-install <job> Cancel an install: a queued job is dropped;
                                 a running job stops its download or build
                                 and installs nothing, unless it already
                                 started registering, which then finishes
  hyperfide-platform plugin outdated             Check installed plugins for compatible
                                 updates (--json for raw results), including
                                 newer releases blocked by engine ranges
  hyperfide-platform plugin update <id> | --all  Apply compatible updates for one plugin or
                                 every tracking plugin. Same confirmation as
                                 install (--yes skips; non-TTY refuses
                                 without --yes)
  hyperfide-platform plugin list                 Status, services, schedules, handler timings,
                                 and contributed CLI commands. `hyperfide-platform status`
                                 also names enabled plugins that are
                                 incompatible, failed, or missing
  hyperfide-platform plugin source <id> [--json] Requested and resolved source, subdirectory,
                                 semver range and resolved tag, engine ranges,
                                 install time, and recent activation history
  hyperfide-platform plugin enable|disable <id>  Load or unload an installed plugin. A
                                 builtin you never toggled follows bb's
                                 default; an explicit choice persists across
                                 releases
  hyperfide-platform plugin safe-mode [on|off]   Show or change safe mode. `on` stops every
                                 plugin you installed (official store plugins
                                 included) without changing its enabled
                                 setting; builtins keep running. `off`
                                 restarts them and exits 1 if any fail.
                                 Installs and updates of stopped plugins are
                                 refused until it is off
  hyperfide-platform plugin reload [id]          Restart plugins on their current sources.
                                 Exits 1 when one does not come up (the
                                 previous instance is kept or degraded)
  hyperfide-platform plugin config <id> [set <key> <value> | unset <key>]
                                 Show or change a plugin's declared settings.
                                 Running plugins receive changes live; a
                                 plugin waiting for configuration retries
  hyperfide-platform plugin logs <id> [-n N] [-f]  Print (or follow) a plugin's log
  hyperfide-platform plugin run <id> [args...]   Run a plugin command explicitly (also works
                                 when a core command owns its name)
  hyperfide-platform plugin token <id> [--rotate]  Print the token for a plugin's
                                 token-authenticated HTTP routes; --rotate
                                 replaces it
  hyperfide-platform plugin remove <id>          Uninstall and delete the plugin's settings,
                                 secrets, and schedules (local path sources
                                 stay on disk; builtin removals are
                                 remembered)
  hyperfide-platform plugin prune [--dry-run]    Delete cached git:/npm: plugin versions no
                                 installed plugin uses (left by earlier hyperfide-platform
                                 releases, rolled-back updates, or
                                 interrupted operations) and leftover cache
                                 directories, and print what was freed.
                                 Updates and removals already delete what
                                 they replace. Never touches a running
                                 version or a local path source. Also in the
                                 command palette

  hyperfide-platform marketplace add <source>    Add a marketplace from an https manifest URL,
                                 git:<url>[@<ref>], or path:<directory>.
                                 Adding a marketplace installs nothing. For a
                                 git: source, --subdirectory <path> reads
                                 marketplace.json from that directory of the
                                 repository instead of its root
  hyperfide-platform marketplace list            Name, source, entry count, and last refresh
                                 (--json for raw rows)
  hyperfide-platform marketplace refresh [name]  Re-read one catalog or all of them. Never
                                 installs, updates, or runs plugin code; a
                                 failed refresh keeps the last valid catalog
                                 and exits non-zero
  hyperfide-platform marketplace remove <name>   Forget a marketplace. Plugins installed from
                                 it keep running as direct installs and keep
                                 updating from their recorded source.
                                 bb-official and bb-community cannot be
                                 removed

Installed plugins and their settings also appear under Settings → Installed
plugins.

Plugin CLI commands

A plugin can register one top-level `hyperfide-platform` subcommand (for example
`hyperfide-platform github …`); run it like any core command. Core command names win on a
collision, and `hyperfide-platform plugin list` then shows the `hyperfide-platform plugin run <id>` form.
Inside agent threads the generated `plugin-commands` skill lists every
available plugin command. Most plugin commands accept `--json` and `--help`.

Bundled plugins

Each bundled plugin documents its commands and behavior in its own skill.

- Prompt Library (builtin, disabled by default): enable with
  `hyperfide-platform plugin enable bb--prompt-library`. Open **+ → Prompts…** or press
  **Ctrl+R** to search, preview, star, and insert prompts. Its commands and
  behavior are documented in the `prompt-library` skill.
- Custom instructions (builtin): up to 4,096 characters saved under
  Settings → Custom instructions are added to every agent task on this host.
  `hyperfide-platform instructions get`, `hyperfide-platform instructions set <text...>`, and
  `hyperfide-platform instructions clear`.
- Account Pooler (builtin, off by default): pools Claude and Codex accounts
  behind the hyperfide-platform server with quota-aware failover. Run
  `hyperfide-platform plugin enable account-pool`, then `hyperfide-platform pool account add`,
  `hyperfide-platform pool status`, and `hyperfide-platform pool routing`; see the `account-pool` skill.
- Keep Awake (builtin): prevents idle sleep on selected macOS and Windows
  hosts while hyperfide-platform runs; closing the lid still sleeps.
  `hyperfide-platform keep-awake status|enable|disable [--json]`, `hyperfide-platform keep-awake hosts all`,
  or `hyperfide-platform keep-awake hosts <host-id>...`.
- Concurrency limit (builtin): caps running threads overall and per host.
  `hyperfide-platform concurrency-limit status|global|host`; see the `concurrency-limit`
  skill.
- Provider retry (builtin): queues an automatic retry after provider
  overloads, server or connection errors, and subscription-window limits.
  `hyperfide-platform provider-retry status|explain|retry|cancel`; see the `provider-retry`
  skill.
- Thread list (builtin): owns the sidebar's layout preferences, synced to
  every window. `hyperfide-platform thread-list prefs list|get|set|reset`; see the
  `thread-list` skill.
- Push notifications (builtin): notifies mobile, web, and desktop clients
  when a thread needs attention.
  `hyperfide-platform push-notifications status|list|add|remove|test|thread`; see the
  `push-notifications` skill.
- Secrets (builtin): `hyperfide-platform secret request <NAME...> --write-env <path>` collects
  credentials through a secure form into a dotenv file without exposing them
  to the agent; see the `secrets` skill.
- Inline previews (builtin): shows an HTML page inline in a reply, from a
  fenced `inline-vis` code block or a `::inline-vis{file="demo.html"}`
  workspace or thread-storage file; see the `inline-vis` skill.
- MCP server (builtin, disabled by default): `hyperfide-platform plugin enable bb--mcp` lets
  ChatGPT, Claude, or another MCP client control this bb; an approved app can
  run any `hyperfide-platform` command. `hyperfide-platform mcp status|clients|revoke`; see the `mcp` skill.
- Storage & retention (builtin, disabled by default): enable with
  `hyperfide-platform plugin enable bb--storage-retention`. Owns thread retention policies
  and machine storage cleanup through its sidebar panel and `hyperfide-platform storage`
  commands; see the `storage-retention` skill.
- Automations (builtin): recurring or one-shot agent prompts and stored
  server scripts. `hyperfide-platform automation create|list|show|update|pause|resume|run|runs|delete`;
  see the `automations` skill.
- Workflows (builtin, off by default): durable JavaScript orchestration of
  worker threads. Run `hyperfide-platform plugin enable workflows`, then
  `hyperfide-platform workflows validate|run|status|history|list|stop`; see the `workflows`
  skill.
- Memory (official, `hyperfide-platform plugin install memory`): durable cross-provider
  agent memory. `hyperfide-platform memory catalog|search|get|add|update|forget|history`;
  see the `memory` skill.
- Docs (official, `hyperfide-platform plugin install docs`): document vaults with a
  pull/edit/push loop and reviewable proposals.
  `hyperfide-platform docs vaults|list|read|pull|status|push|propose`; see the `docs` skill.
- Tasks (official, `hyperfide-platform plugin install tasks`): a task tracker with agent
  delegation. `hyperfide-platform tasks show|list|comment|update|attach`, and
  `hyperfide-platform tasks --help` for the rest; see the `tasks` skill.
- Modal sandboxes (official, `hyperfide-platform plugin install environment-modal-sandbox`):
  reusable Modal cloud machines. `hyperfide-platform modal account inspect`,
  `hyperfide-platform machine create --provider modal-sandbox`, and `hyperfide-platform modal image|sandbox`;
  see the `modal-sandboxes` skill.

Multi-plugin repositories

One repository can hold several plugins, each an ordinary plugin directory
with its own package.json. An optional `.hyperfide/plugins.json` collection manifest
indexes them:



Every source is a repository-relative directory starting with "./"; absolute
paths, "..", the repository root, duplicate names, and unknown fields are
rejected. The file is an index only: identity, branding, entry points, and
engine ranges stay in each plugin's manifest.

  hyperfide-platform plugin install git:github.com/acme/repo@main --plugin sidebar
  hyperfide-platform plugin install git:github.com/acme/repo@main --subdirectory plugins/sidebar
  hyperfide-platform plugin install path:/work/repo --plugin sidebar

--subdirectory works without a collection manifest; --plugin resolves a name
from .bb/plugins.json. When a repository with a collection manifest is not a
plugin itself and neither flag is given, the install fails and lists the
entry names. hyperfide-platform records the subdirectory, so outdated, update, and remove
work per plugin.

Marketplaces

`bb-official` lists the plugins bundled with the app. It reads a local catalog
and never uses the network; install its entries by bare name or qualified name
(`hyperfide-platform plugin install docs` or `hyperfide-platform plugin install docs@bb-official`). An app
update also updates the bundled copy.



Anyone can host a third-party marketplace:

  hyperfide-platform marketplace add https://plugins.acme.dev/marketplace.json
  hyperfide-platform marketplace add git:github.com/acme/bb-marketplace@main
  hyperfide-platform marketplace add git:github.com/acme/agent-plugins@main --subdirectory hyperfide-platform
  hyperfide-platform marketplace add path:/work/acme-marketplace

--subdirectory follows the same path rules as `hyperfide-platform plugin install
--subdirectory`; hyperfide-platform reads marketplace.json and relative icons from that
directory on every refresh. `source.git.subdir` in a catalog entry stays
relative to the repository root.

The manifest `name` is the marketplace identity; duplicates and the reserved
`bb-official` and `bb-community` names are refused. Install an entry of a
specific marketplace with <entry-id>@<marketplace>:

  hyperfide-platform plugin install thread-hover-cards@acme-plugins

A bare id resolves across every marketplace: one match installs, several
matches fail and list the id@marketplace choices. Other source forms bypass
catalog resolution. Before installing from a third-party marketplace, hyperfide-platform shows
the marketplace, the entry's author, and the true source, including the exact
release tag and commit a range lands on. `--yes` skips the prompt, not the
resolution, and the install is refused if the listing or resolved commit
changes after confirmation. Settings → Plugin marketplaces manages the same
list. To publish a marketplace, see the bb-plugin-authoring skill.

Updates and pinning

Updates are manual: `hyperfide-platform plugin outdated` checks tracking sources and
`hyperfide-platform plugin update` applies compatible candidates. Reinstalling an installed
managed plugin is refused; use `hyperfide-platform plugin update`. A failed activation restores
the previous version and leaves the failure visible.

Exact npm versions, Git tags and commits, path sources, and bundled official
plugins are pinned. npm ranges, dist-tags, and omitted specs, omitted Git refs
(the default branch), Git branches, and Git semver ranges track compatible
updates. Change a pinned git:/npm: source with `hyperfide-platform plugin remove` (which
deletes settings, secrets, and schedules) and a fresh install. Edit a local
path plugin in place and `hyperfide-platform plugin reload <id>`, or move it with
`hyperfide-platform plugin install path:<new dir>`; both keep its configuration.

Managed git:/npm: installs refuse engines.bb and engines.bbPluginSdk
mismatches, manifest and artifact identity mismatches, and ids reserved by
bundled plugins. Git and path installs build the plugin on install (git
sources need `git`; hyperfide-platform ships its own npm), and a build failure fails the
install. npm packages must ship their prebuilt app and host bundles.

Git semver ranges

A git source can track releases over the repository's tags:

  hyperfide-platform plugin install git:github.com/acme/repo@^1.2.0
  hyperfide-platform plugin install git:github.com/acme/repo@semver:^1.2.0
  hyperfide-platform plugin install git:github.com/acme/repo@^1.2.0 --tag-prefix notes/

hyperfide-platform keeps tags named [<tag-prefix>]vX.Y.Z and installs the highest one the
range allows. Prereleases are excluded unless the range names one. Without
--tag-prefix tags are repository-wide (v1.2.3); with it they version one
plugin (notes/v1.2.3).

hyperfide-platform records the selected tag and its commit. If that tag later points at
another commit, hyperfide-platform refuses it and names both commits; remove and reinstall
the plugin to accept the new commit.

A bare spec that reads as a range (`^1.2.0`, `1.x`, `>=1 <2`) resolves over
tags only when no branch or tag has that literal name; when one does, the
install fails and asks you to choose `@semver:<range>` or `@ref:<name>`. Bare
version tags such as `v1` and `v1.2.3` are always the literal tag.

Authoring a plugin

  hyperfide-platform plugin new <name>           Scaffold ./bb-plugin-<name> (backend, sidebar
                                 page, `hyperfide-platform <name>` command, skill) and install
                                 its npm dependencies; no server required
  hyperfide-platform plugin install .            Register the directory in place
  hyperfide-platform plugin dev [path]           Watch sources, rebuild, and reload the
                                 installed plugin on every save
  hyperfide-platform plugin build [path]         Compile the plugin into dist/; no server
                                 required
  hyperfide-platform plugin types [path] [--check]  Sync the plugin's SDK and shimmed-package
                                 type pins to this bb; --check only reports
  hyperfide-platform plugin migrate [path] [--yes]  Move a plugin that vendors types/ to the
                                 @get-bb/plugin-sdk npm package

The full authoring reference (manifest, every API surface, build and release,
testing, and marketplace publishing) is the built-in `bb-plugin-authoring`
skill; in a checkout it lives under plugins/bb-guide/skills/bb-plugin-authoring/.
`plugins/` holds every bundled plugin and `examples/plugins/` holds reference
plugins.

## Inspect plugin RPC

`hyperfide-platform plugin rpc list [plugin-id] [--method <exact-name>] [--json]` lists discoverable methods from running plugins, optionally restricted to one plugin. `hyperfide-platform plugin rpc inspect <plugin-id> [method] [--json]` dumps registration and method descriptions plus input/output JSON Schemas. Copy the relevant schema into your consumer and call the existing plugin RPC endpoint. Discovery is opt-in advertising, not access control; method names may carry versions such as `provider-usage.v1.listResources`.

`hyperfide-platform plugin rpc call <plugin-id> <method> [--input-file <json-path>] [--json]` invokes a method using server-side schema validation. Omitting the input file sends JSON null. Input files avoid putting sensitive values in command arguments. Handler refusals print their code and message and exit non-zero: `forbidden` (403), `not_found` (404), `conflict` (409), or `invalid` (422).

### Background updates

`hyperfide-platform plugin update <id> --yes` starts a server job and waits by polling, so the activation stability check does not hold one HTTP request open. Add `--no-wait` to return immediately. Use `hyperfide-platform plugin update-jobs [job-id] --json` for progress and results, including automatic rollback. Queued/running updates continue after the CLI or app disconnects. Finished jobs remain for ten minutes; jobs do not survive server restarts. Running updates cannot be cancelled midway through activation.

SDK: `plugins.applyUpdate({ pluginId })` waits; `plugins.experimental_startUpdate({ pluginId })` returns the job. Inspect with `plugins.experimental_updateJobs.list()` or `.get({ jobId })`. Raw HTTP callers opt in with `Prefer: respond-async`; legacy callers still receive the completed result.
