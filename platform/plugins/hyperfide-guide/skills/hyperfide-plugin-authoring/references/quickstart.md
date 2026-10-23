# Plugin quickstart

## Quickstart

```
hyperfide-platform plugin new hello            # scaffolds ./hyperfide-plugin-hello: a todo list with a sidebar page, `Hyperfide hello` CLI, and a skill
cd hyperfide-plugin-hello
hyperfide-platform plugin install .            # registers the directory in place (--yes to skip the prompt)
hyperfide-platform plugin dev                  # rebuild app/host bundles + reload on every save
```

`hyperfide-platform plugin new` needs no running server. It installs the scaffold's npm
dependencies, including `@hyperfide/plugin-sdk` pinned to this Hyperfide's exact SDK
version, and warns when that SDK version is not on npm yet. When npm leaves a
package out, it prints the manual `npm install --include=dev` step to run
before `hyperfide-platform plugin build`.

## Manifest

The manifest is `package.json`. This block is illustrative. The scaffold adds
the current engine values and the entries for its generated surfaces.

```json
{
  "name": "hyperfide-plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "Hyperfide": {
    "name": "Hello",
    "description": "A friendly example plugin.",
    "branding": { "icon": "Zap" },
    "server": "./server.ts",
    "app": "./app.tsx",
    "skills": ["skills"]
  }
}
```

- `hyperfide.server` (required) — backend entry; see backend-foundation.md.
- `hyperfide.app` (optional) — frontend entry; see frontend-registration.md.
- `hyperfide.host` (optional, singular) — full-trust Node 22 ESM entry that the
  daemon runs on hosts. The server entry calls it through typed host RPC, and
  provider bridges ship in it; see "hyperfide.hosts" in backend-foundation.md.
- `hyperfide.skills` (optional) — relocates the auto-imported skills directories
  (default `skills/`; `[]` opts out). Every `skills/<name>/SKILL.md` is
  injected into agent threads as the plugin skills tier.
- `hyperfide.themes` (optional) — contributes palettes to Settings → Appearance and
  `Hyperfide theme list`. Each entry is
  `{ id, name, description?, css: "./themes/name.css", codeTheme? }`;
  `codeTheme` is `{ dark?, light? }` where each side is a bundled Shiki /
  Pierre name or a plugin-relative VS Code theme `.json` file. Hyperfide namespaces
  its selectable id as `plugin:<plugin-id>:<id>`. Only loaded plugins
  contribute.
- `hyperfide.name` and `hyperfide.description` (required) — non-empty human-facing plugin
  identity. The top-level package `name` remains the package identity and
  source of the plugin id. distribution.md covers how the store uses
  `hyperfide.description`. To label a plugin's status, end `hyperfide.name` (or a
  marketplace `displayName`) with one short bracketed tag, such as
  `Account Pooler [Experimental]` or `Memory [Early access]`. Plugin
  cards and details show the bracketed text as a tag beside the name: gray by
  default, and colored for reserved tags (`[Experimental]`). Write the tag in
  sentence case (`[Early access]`, not `[Early Access]`), keep it to 24
  characters or fewer, and use brackets, not parentheses; longer or other
  suffixes stay part of the name. Older Hyperfide versions show the full name as text.
- `hyperfide.branding` (required) — declare `hyperfide.branding.icon` as either the plugin's
  canonical HYPERFIDE icon name, such as `Zap`, or a plugin-relative compact SVG path
  such as `./assets/icon.svg`. A namespaced `"<pluginId>/<name>"` glyph is
  refused here; the plugin's own mark points at its file directly. HYPERFIDE
  validates path-shaped SVGs (well-formed XML with an `<svg>` root, no
  doctype or processing instruction), hash-serves them, then renders them as
  CSS masks so their shape inherits the surrounding text color; SVG colors
  are ignored. Named inline icons use `currentColor`; compact SVG assets
  should contain only the intended transparent glyph shape.
  HYPERFIDE reuses this icon on roomy surfaces when no logo override is declared.
  Add `logo.light` only for intentionally different rich/full-size identity
  artwork; optional `logo.dark` is preferred in dark mode. HYPERFIDE uses a declared
  logo where space permits, such as roomy Settings rows and cards. Logo paths
  are explicit plugin-relative `.svg`, `.png`, or `.webp` files: nulls, empty
  strings, missing/escaping files, unsupported extensions, and a dark logo
  without a light logo fail the manifest. `hyperfide-platform plugin build` refuses an SVG
  logo that carries a script vector (a `script`, `handler` or `listener`
  element, an `on*` attribute, or a `javascript:` href). Every SVG HYPERFIDE serves
  carries `nosniff` and a `default-src 'none'` CSP. There is
  no root logo auto-detection. Logo-only manifests remain supported, so at
  least an icon or light logo is required. Do not duplicate the same artwork
  across `icon` and `logo`.
  Compact sidebar, menu, action, mention, and panel-title surfaces prefer the
  plugin-owned icon asset, then a named manifest icon, then a contribution's
  local `icon` hint, then Zap. Branding changes are picked up on
  `hyperfide-platform plugin reload`.
- `hyperfide.branding.experimental_icons` (optional) — the plugin's own icon
  vocabulary for timeline rows, tool presentations, and provider marks: a map
  of declared name → plugin-relative SVG, such as
  `{ "receipt": "./icons/receipt.svg" }`. Names start with a lowercase letter
  or digit and then use lowercase letters, digits, or `-` (≤ 48 characters,
  ≤ 64 entries); each file is a `.svg` inside the plugin directory, at most
  32 KiB, and must pass a reject-only validator: no doctype or processing
  instruction; no `script`, `handler`, `listener`, `iframe`, `foreignObject`,
  `image`, `video`, `audio`, `a` or `style` element; no element outside the
  SVG namespace; no `on*` attribute; no `href`/`xlink:href` that is not a
  same-document `#` reference; no backslash (CSS escape) in any attribute
  value; no `url()`, `src()`, `image()` or `image-set()` in any attribute
  value unless it targets a same-document `#` reference; no SMIL
  `attributeName` naming an `on*` handler or an `href`; no `xml:base`. Any
  violation fails the plugin load with a message naming the icon.
  Reference an entry by its namespaced glyph `"<pluginId>/<name>"` anywhere a
  HYPERFIDE icon name is accepted; another plugin's id or an undeclared name is
  refused. HYPERFIDE serves each file hashed from
  `/api/v1/plugins/<id>/assets/icons/<name>.svg`, lists them on the
  installed-plugin inventory as `icons`, and draws them as `currentColor`
  masks (web) or tinted SVG views (mobile), so ship monochrome shapes. How a
  persisted row's glyph is checked and what it falls back to is the
  presentation contract in `docs/provider-plugin-api.md` §3.
- `engines.hyperfide` — optional compatibility range checked at load and during
  update selection against the HYPERFIDE app version. Dev builds (Hyperfide `0.0.0`) skip
  enforcing it and annotate that on check results.
- `engines.hyperfidePluginSdk` — optional SDK compatibility range. The scaffold uses
  the repository SDK version. Absent means a legacy manifest. Managed
  (`git:`/`npm:`) installs refuse a plugin that needs a newer SDK than the
  host provides, or one pinned to a different major; path installs surface it
  as `incompatible` at load. Updates select only candidates that satisfy both
  ranges (see distribution.md).

## Plugin id

Default to `hyperfide-plugin-hello` for the package name. Scoped names such as
`@acme/hyperfide-plugin-hello` are also supported. The plugin id is the final
package-name component minus the `hyperfide-plugin-` prefix. HYPERFIDE lowercases it,
replaces non-alphanumeric runs with `-`, and trims separators. An empty result
is invalid. Every bundled plugin id is reserved for its bundled source, and
ids starting with `hyperfide--` are reserved for plugins bundled with HYPERFIDE. The id
namespaces routes, storage, settings, and CLI commands.

## Builds, installs, and dependencies

- Path installs load `hyperfide.server` as TypeScript directly. `hyperfide-platform plugin build`
  also emits `dist/server.js` + `server.js.map` + `server.meta.json`; the
  server bundle externalizes the SDK and `better-sqlite3` (use
  `hyperfide.storage.database()` for plugin-owned SQLite). Builtin, official, git,
  and npm installs whose `dist/server.js` was built for the running SDK major
  load that bundle instead of the TypeScript source.
- `hyperfide-platform plugin build` compiles `hyperfide.dev` into minified `dist/app.js`, `app.css`,
  and `app.meta.json` (`hyperfide-platform plugin dev` keeps them readable) and bundles
  `hyperfide.host` into `dist/host.js`, its source map, and `host.meta.json`. Path
  and git installs build automatically at install time, and a build failure
  fails the install. A committed `dist/` is always replaced by the bundles Hyperfide
  builds. Path installs build from dependencies you have already installed.
- Git installs use Hyperfide's bundled npm (neither npm nor Node needs to be on
  `PATH`; `git` does) to run
  `npm install --omit=dev --omit=optional --ignore-scripts` (lifecycle scripts
  never run), keep node_modules (bundling cannot inline data files read at
  runtime), then build declared app, server, and host source and validate its
  metadata. An npm plugin must publish `dist/app.js` + `dist/app.meta.json`
  when it declares `hyperfide.dev`, and its host bundle and metadata when it declares
  `hyperfide.host`.
- `hyperfide-platform plugin build` stamps every declared artifact's `dist/*.meta.json` with
  `sdkMajor`, `sdkVersion`, `artifactFormatVersion` (currently `1`),
  `pluginId`, `pluginVersion`, and `builtWith: { hyperfideVersion, pluginSdkVersion }`.
  Managed installs reject artifacts whose `pluginId`/`pluginVersion` disagree
  with the package manifest, or whose SDK major does not match the host.
- Runtime imports that Hyperfide does not shim belong in `dependencies`; validator
  imports such as Zod are ordinary runtime dependencies that the build
  bundles. `devDependencies` is for types and tooling only. A build-required
  package left there makes the plugin uninstallable from git, and unbuildable
  after any install that omits dev deps — including the packaged CLI's own,
  which runs npm under `NODE_ENV=production`. Every package Hyperfide shims at
  runtime (listed in frontend-hooks-and-ui.md) is the opposite: the build
  never bundles it, but `tsc` still resolves its declarations, so each one you
  import needs a type-only `devDependencies` entry at the host's version
  (`hyperfide-platform plugin new` writes all of them; `hyperfide-platform plugin types` repins them). Never
  put one in `dependencies` — that bundles a second copy beside the host's.
  Host entries have one exception for the SDK itself; see backend-foundation.md.
- Building yourself (CI, or verifying a build without a running Hyperfide): add
  `hyperfide-app` to `devDependencies` and set `"build": "hyperfide-platform plugin build"`.
  `hyperfide-platform plugin build` needs no running server, but the manifest still needs
  `hyperfide.server`; only `hyperfide-platform plugin dev` needs a running Hyperfide, because it reloads the
  installed plugin. Depending on `hyperfide-app@X` builds against exactly that
  release's shim configuration. Hyperfide downloads a pinned esbuild and Tailwind
  toolchain on a machine's first git or path build (never for a prebuilt npm
  install), so cache `<dataDir>/plugins/toolchain-*` in CI.

Backend API imports normally stay type-only. The root runtime exports are
`defineRpcContract`, `experimental_defineHostEntry`, the numeric
`PLUGIN_CLI_OUTPUT_MAX_BYTES` ceiling, and the CLI helpers `defineCli`,
`cliCommand`, and `PluginCliError`:
`import { defineRpcContract, type HyperfidePluginApi } from "@hyperfide/plugin-sdk"`.
The scaffold tsconfig typechecks both `server.ts` and `app.tsx`.

## On-disk state

Each plugin has `<dataDir>/plugins/<id>/data.db` (its SQLite), `secrets/`
(secret settings + HTTP token), and `logs/plugin.log` (JSONL, rotated at
5MB).
