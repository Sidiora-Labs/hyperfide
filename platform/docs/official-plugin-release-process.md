# Releasing HYPERFIDE Official plugins

Official plugins ship **bundled inside the HYPERFIDE app**. There is no separate
publish pipeline: app packaging builds each plugin through its Turbo-cached
`prepare:bundled` task and copies the collection into
`<server dist>/builtin-plugins/<name>`. Plugins → Browse plugins installs
official plugins from that local bundled copy; no network is involved.

Every bundled plugin lives in `plugins/<name>`. The directory does not record
the install policy. `autoInstall` in the registry does: `BUILTIN_PLUGINS`
entries reconcile automatically, and `OFFICIAL_PLUGINS` entries stay store-only
until a user installs them.

The official plugins are:

| Directory                    | Package name                   | Store entry          | Plugin id            |
| ---------------------------- | ------------------------------ | -------------------- | -------------------- |
| `plugins/browser-automation` | `hyperfide-plugin-browser-automation` | `browser-automation` | `browser-automation` |
| `plugins/github`             | `hyperfide-plugin-github`             | `github`             | `github`             |
| `plugins/docs`               | `hyperfide-plugin-simple-notes`       | `docs`               | `simple-notes`       |
| `plugins/memory`             | `hyperfide-plugin-memory`             | `memory`             | `memory`             |
| `plugins/tasks`              | `hyperfide-plugin-tasks`              | `tasks`              | `tasks`              |

## Releasing a change

1. Land the plugin change on `main` like any other code change. Bump the
   plugin's `package.json` version when the change is user-visible — the
   version is shown in plugin management and drives startup reconciliation
   (an installed official plugin re-points to the new bundled copy when its
   version or root directory changes).
2. Ship a normal HYPERFIDE app release. The packaging step builds changed plugins and reuses cached
   outputs for unchanged plugins; installed plugins pick up the new code at
   the next server start.

Never check in `plugins/*/dist` or `plugins/*/.bundled-runtime`; they are generated.

## Adding a new official plugin

1. Create the plugin under `plugins/<name>` with a `hyperfide platform` manifest
   block (`server`, optional `app`, `branding`, optional `skills`). Name the
   package `hyperfide-plugin-hyperfide--<name>` so its plugin id is `hyperfide--<name>`. HYPERFIDE refuses
   non-bundled installs of `hyperfide--` ids and the marketplace rejects them, so a
   new bundled plugin cannot collide with a community plugin. The ids bundled
   before this rule are frozen in
   `apps/server/test/services/plugins/builtin-registry.test.ts`.
2. Add an entry to `OFFICIAL_PLUGINS` in
   `apps/server/src/services/plugins/builtin-registry.ts` with the store
   `name`, the derived `pluginId`, `defaultEnabled`, and a `category` for the
   Browse tab. The registry-invariant test
   (`apps/server/test/services/plugins/official-plugins.test.ts`) verifies the
   declared plugin id matches the manifest.

3. Add `@hyperfide/plugin-build` as a `workspace:*` dev dependency and
   `"prepare:bundled": "hyperfide-plugin-build prepare-bundled"` to the plugin's scripts.
   Add the plugin's package as a workspace dependency of `@hyperfide/bundled-plugins`.
   Keep task configuration in the root `turbo.json`.

## Verify locally

```bash
pnpm exec turbo run build --filter=hyperfide-app
ls packages/hyperfide-app/server/dist/builtin-plugins
```

Every bundled plugin directory must contain a rewritten `package.json`
pointing at `./dist/server.js` plus the prebuilt `dist/` artifacts. Then, in a
dev build:

```bash
hyperfide platform plugin search docs
hyperfide platform plugin install docs --yes
hyperfide platform plugin list
hyperfide platform plugin remove simple-notes
```
