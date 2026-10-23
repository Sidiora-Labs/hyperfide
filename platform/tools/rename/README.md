# Hyperfide identity migration

Run with Node 24 from the repository root:

```sh
node platform/tools/rename/apply.mjs --dry-run platform > /tmp/hyperfide-rename.json
node platform/tools/rename/apply.mjs --apply platform
pnpm -C platform install --no-frozen-lockfile
bash tests/hyperfide/cases/v22/0_1.sh
```

This task provides the migration; it does not apply it to the platform. The applying task must reinstall dependencies and commit the regenerated lockfile.

The ordered JSON array is the authority. Each rule has `from`, `to`, `kind`, `paths`, and `exclude`. Source patterns use JSON Unicode escapes to keep historical identity out of newly written repository text. Directory destinations also escape intermediate ancestor names. Decode with JSON.parse when inspecting them; no external lookup is required.

Text rules match literal strings. Identifier rules require a leading word boundary and a trailing word boundary for complete identifiers. Prefixes ending in an underscore intentionally permit identifier suffixes. Specific scopes, telemetry names and domains precede broad prefixes, and the standalone CLI rule runs last. Product metadata and documentation headings have separate Hyperfide product rules. All content rules run before directory rules. Directory moves run deepest first, changing only the final component so an ancestor can subsequently move the subtree.

Paths and exclusions are root-relative globs (`*` within a component, `**` across components). The walker skips node_modules, dist, .turbo, .git, licenses, environment files, symlinks, non-UTF-8 files, binary files, lockfiles, and the tool's own directory. Tracked directory moves were derived from the source tree and checked against git ls-files; generated untracked directories are not git move candidates. Destination collisions fail before any writes. Apply requires a Git checkout with source directory contents tracked. Text writes preserve modes; Git moves preserve tracked history. As with other migrations, use a clean checkout so a failed Git operation can be reviewed before retrying.

Dry-run is read-only. Its JSON contains ordered per-rule counts and per-file counts, a file-to-rule count index, and the planned directory moves. Counts are literal occurrences at each step of the ordered migration, rather than overlapping matches in the original input. A second application reports zero replacements and moves.

## Tree inventory

Inventory taken from platform/ on 2026-10-23, before application, using recursive occurrence searches for scope, environment, data-path, plugin/package prefix, product-case and domain classes, followed by the exact ordered dry-run. The table identifies historical classes by rule index and the new destination so this documentation introduces only Hyperfide identity. Counts include eligible ignored text assets but exclude the walker omissions above. Directory counts are tracked source directories, not generated runtime caches.

| Rule | Kind | Destination / occurrence class | Occurrences | Files |
| --- | --- | --- | ---: | ---: |
| 0 | text | `# Hyperfide` | 79 | 46 |
| 1 | text | `"productName": "Hyperfide"` | 1 | 1 |
| 2 | text | `@hyperfide/` | 1743 | 1066 |
| 3 | text | `@hyperfide/` | 7756 | 3019 |
| 4 | identifier | `HYPERFIDE_TELEMETRY` | 34 | 20 |
| 5 | identifier | `HYPERFIDE_` | 5353 | 604 |
| 6 | text | `.hyperfide` | 3199 | 527 |
| 7 | text | `hyperfide.github.io` | 38 | 2 |
| 8 | text | `hyperfide.app` | 1381 | 244 |
| 9 | text | `hyperfide.localhost` | 1 | 1 |
| 10 | text | `hyperfide` | 285 | 110 |
| 11 | text | `hyperfide` | 130 | 46 |
| 12 | text | `hyperfide.dev` | 2 | 1 |
| 13 | text | `hyperfide.app` | 54 | 28 |
| 14 | text | `hyperfide-` | 10923 | 1731 |
| 15 | text | `hyperfide_` | 511 | 173 |
| 16 | text | `Hyperfide` | 3883 | 652 |
| 17 | identifier | `HYPERFIDE` | 2276 | 589 |
| 18 | identifier | `hyperfide-platform` | 19502 | 1979 |
| 19 | path | `apps/server/test/fixtures/plugins/hyperfide-plugin-builtin-fixture` | 1 | 0 |
| 20 | path | `apps/server/test/fixtures/plugins/hyperfide-plugin-sdk-0.4.8-scaffold` | 1 | 0 |
| 21 | path | `packages/hyperfide-app` | 1 | 0 |
| 22 | path | `plugins/hyperfide-account` | 1 | 0 |
| 23 | path | `plugins/hyperfide-account/skills/hyperfide-account` | 1 | 0 |
| 24 | path | `plugins/hyperfide-ai` | 1 | 0 |
| 25 | path | `plugins/hyperfide-ai/skills/hyperfide-cloud-ai` | 1 | 0 |
| 26 | path | `plugins/hyperfide-guide` | 1 | 0 |
| 27 | path | `plugins/hyperfide-guide/skills/hyperfide-cli` | 1 | 0 |
| 28 | path | `plugins/hyperfide-guide/skills/hyperfide-plugin-authoring` | 1 | 0 |
| 29 | path | `plugins/theme-preview/skills/hyperfide-theme-authoring` | 1 | 0 |
| 30 | path | `.hyperfide` | 1 | 0 |

The two scope classes converge to @hyperfide/. Dedicated telemetry handling precedes the general HYPERFIDE_ prefix. Broad text prefixes cover plugin IDs, package directory references, CSS names, fixture identifiers and string variants without maintaining an incomplete list of suffixes. Remaining case variants and standalone tokens have explicit rules. The directory inventory includes the data directory, launcher package, plugin directories and authored skill directories.

The fixture verification creates an isolated Git repository beneath fixtures/rename, exercises all mapped source strings and tracked directory moves, verifies skipped contents and identifier boundaries, compares dry-run with apply, checks the resulting content and tree, and asserts a second application has no changes. It then dry-runs the real platform tree and requires nonzero coverage of all three rule kinds. The fixture is removed after the check, leaving only its tracked placeholder.
