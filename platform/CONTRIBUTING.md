# Contributing to Hyperfide

Development happens in https://github.com/Sidiora-Labs/hyperfide. Report bugs,
propose changes, and request support through its GitHub issues:
https://github.com/Sidiora-Labs/hyperfide/issues.

Follow the root workflow and the active feature spec before implementing a task.
Keep changes within its touches and record verification evidence.

## Toolchain and checks

Use Node 24 and pnpm 9.15. From the repository root:

```sh
pnpm -C platform install --frozen-lockfile
pnpm -C platform exec turbo run typecheck test --filter=./apps/app
```

Replace the directory filter with each affected package. When a manifest changes,
run `pnpm -C platform install --no-frozen-lockfile` and include the lockfile.
Use `hyperfide platform --help` for platform command help.

Describe the concrete behavior change, relevant tests, and remaining limitations
in each contribution. Keep credentials and personal runtime data out of commits.
