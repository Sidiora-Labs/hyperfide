See the GitHub pull request for each thread's branch where you already work: the composer banner, the Info panel and sidebar plugins that show PR badges. Mark it ready, convert it back to a draft or merge it without leaving hyperfide platform.

## What you get

- One rolled-up status per pull request: checks, review, conflicts, merge queue and auto-merge.
- Ready for review, Convert to draft and Merge (merge, squash or rebase).
- Live updates while you watch: pending checks are re-checked every 30 seconds, and views refresh only when something changed.

## How it works

The plugin runs `gh pr view` in the environment's workspace on its own machine, so fork and upstream remotes and that machine's `gh` login apply. hyperfide platform never wakes a sleeping machine for PR status; a suspended or offline machine shows no PR until it is back.

Use the CLI from any thread:

- `hyperfide platform pull-request show <environment-id>` prints the pull request.
- `hyperfide platform pull-request ready|draft <environment-id>` changes draft state.
- `hyperfide platform pull-request merge <environment-id> --method squash` merges it.

## Requirements

Install the GitHub CLI and run `gh auth login` on each machine whose pull requests you want to see.
