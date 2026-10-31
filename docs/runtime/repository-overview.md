# Hyperfide repository overview

The runtime uses the category directories at the root of
https://github.com/Sidiora-Labs/hyperfide. Node 24 and pnpm 9.15 drive one workspace.



From the repository root, use `pnpm <script>`. Limit package checks
with directory filters, for example:

```sh
pnpm exec turbo run typecheck test --filter=./apps/web
```

See [system overview](system-overview.md) and [configuration](configuration.md).
Support and bug reports belong in
https://github.com/Sidiora-Labs/hyperfide/issues.
