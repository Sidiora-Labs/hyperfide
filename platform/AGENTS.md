# Hyperfide platform agent instructions

Follow the root AGENTS.md and spec/workflow.kvx. Claim one eligible spec task,
read its acceptance criteria and touches, and use `hyperfide survey` followed by
`hyperfide context` before editing. Raise an Ask when required information is missing.

The platform is a pnpm 9.15 workspace on Node 24. Run workspace commands from the
repository root with `pnpm -C platform`. Use directory filters for package checks:

```sh
pnpm -C platform exec turbo run typecheck test --filter=./apps/app
```

Use Hyperfide identity in new code and documentation: `@hyperfide/` packages,
`HYPERFIDE_` configuration, `~/.hyperfide` data, `hyperfide-` plugin identifiers,
and `hyperfide platform <command>` for the public command line.

Keep source imports and runtime contracts consistent when changing names.
Run the claimed task's real verification command before marking it implemented.
Use GitHub issues at https://github.com/Sidiora-Labs/hyperfide/issues for support.
