# Hyperfide release process

Releases are governed by the active feature spec in this repository. Implement
and verify each task, qualify the wave, and collect the resulting receipts before
publication. A task implementation alone does not qualify a release.

Use Node 24 and pnpm 9.15. From the repository root:

```sh
pnpm -C platform install --frozen-lockfile
pnpm -C platform exec turbo run typecheck test build
```

The release task owns version changes and release artifacts. Validate the desktop
product metadata, native icons, and mobile production/development configuration
with `bash tests/hyperfide/cases/v22/0_6.sh`. Test packaged applications on each
supported operating system before describing them as supported.

Publish only through the spec's publication workflow. Source and issue tracking:
https://github.com/Sidiora-Labs/hyperfide.
