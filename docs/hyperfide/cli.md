# Hyperfide platform CLI

`hyperfide platform <args...>` executes the platform CLI. Use
`hyperfide platform --help` to see its commands; `hyperfide help platform`
describes the front door.

The executable lookup order is:

1. An executable file named by `HYPERFIDE_PLATFORM_BIN`.
2. `platform/apps/cli/bin/hyperfide-platform` under the repository root.
3. `hyperfide-platform` on `PATH`.

The root is the nearest ancestor with `.git` or `.codegraph`, including git
worktrees. Outside a repository, the current directory is used. The child
receives `HYPERFIDE_REPO_ROOT` set to this absolute root, the inherited environment
and streams, and all arguments unchanged. Its exit status is preserved.
An unavailable CLI prints the locations searched to stderr and exits 69.
See also [the manual page](hyperfide-platform.1).
