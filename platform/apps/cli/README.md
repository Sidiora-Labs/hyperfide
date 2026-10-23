# Hyperfide Platform CLI

Build with `pnpm -C platform exec turbo run build --filter=./apps/cli`.
Run `node platform/apps/cli/bin/hyperfide-platform --help` for commands,
`hyperfide-platform <command> --help` for options, or use the root workspace
scripts `pnpm -C platform hyperfide-platform` and
`pnpm -C platform hyperfide-platform:dev`.

Runtime configuration uses `HYPERFIDE_` environment variables, including
`HYPERFIDE_SERVER_URL`, `HYPERFIDE_HOST_DAEMON_PORT`, and `HYPERFIDE_DATA_DIR`.
Production data defaults to `~/.hyperfide`. On first use, an existing legacy
production data directory moves there when the destination is absent; the
migration logs its source and destination. An explicit data directory bypasses
migration. Existing destination data is preserved.

The `title` helper remains available alongside `hyperfide-platform`.
