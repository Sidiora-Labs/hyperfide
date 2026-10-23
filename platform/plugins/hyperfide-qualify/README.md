# Hyperfide wave closure and publication

`server.ts` registers wave, human mark, prepare and publish RPC handlers.
`app.ts` mounts the closure view and operator buttons; `cli.ts` exposes the same
closure and publication operations to the command surface. Operator identity
comes from the host, never from an RPC request or a worker-supplied name.

The unmerged dependencies are isolated in
`../hyperfide-spec/closure-projection.ts`: the spec authority supplies wave tasks
and persists human marks, qualification supplies commit-bound lane, receipt check
and checker results, and the Asks plugin supplies its blocking policy and
operator-authored permission answers. The host must supply durable publication
storage shared by calls and serialize publication operations per repository.
Replace these projection interfaces with the merged plugins during integration;
there is no alternate source of authority or automatic operator mark.

All three human jobs must be marked, all tasks done, all checkers passed, every
lane and receipt closure check passed at the task commit, and all Asks answered.
Prepare creates `publication/<feature>/wave-<number>` from the explicit base in
an isolated worktree. It squash-merges each task's immutable source commit and
creates exactly one task commit carrying its id, title and spec tag. Task commits
must belong to the wave and merge cleanly in the authority's task order.

Prepare raises a blocking permission Ask bound to the head, closure snapshot,
remote and summary. Publish reads the answer from the Asks plugin, requires a
grant attributed to an operator, and rechecks closure and branch integrity. A
refusal leaves the branch local. Only absolute local bare remotes are accepted;
this implementation never fetches or pushes to a network remote. A saved pushed
publication is reused on retry, and PR creation can retry without another push.
An approved publication whose wave or head changes must be superseded by the
operator through the authority before preparing again; stale approval cannot be
reused. The GitHub plugin's `wavePullRequests` adapter is optional and receives
the wave summary only after push succeeds.

Tests use temporary Git repositories, local bare remotes, a projection plugin
host and a fake GitHub client. They never mutate this repository's spec or
artifacts. Run `bash tests/hyperfide/cases/v22/4_4.sh` at the repository root.
