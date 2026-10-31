# Bundled plugin changes

Bundled runtime plugins live under `plugins/`. The workspace package
`tools/bundled-plugins` collects their build outputs for the server.
Use the package manifest and server registry as the source of truth for each
plugin's identity and install policy; a directory name alone does not determine
whether it is installed automatically.

From the repository root, check the changed plugin with its directory filter:

```sh
pnpm exec turbo run typecheck test --filter=./plugins/memory
pnpm build
```

Keep generated dist and bundled runtime directories out of Git. If dependencies
change, run `pnpm install --no-frozen-lockfile` and include the lockfile.
After rebuilding, inspect the running server with `hyperfide platform plugin list`.

Plugin changes ship with the repository's release artifacts. The active spec
owns qualification, version changes and publication; see the
[release process](hyperfide-release-process.md). An implemented plugin task does not qualify
a release. The [platform guide](../../docs/hyperfide/platform.md) records which
authority integrations have actually merged and the proof commands for each.
