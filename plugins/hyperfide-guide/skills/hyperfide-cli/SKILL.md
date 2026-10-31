---
name: hyperfide-cli
description: "Inspect or manage HYPERFIDE state with the Hyperfide CLI; use for HYPERFIDE commands and configuration."
---

# HYPERFIDE CLI

Use Hyperfide for HYPERFIDE state and actions. `hyperfide-platform guide` is the reference manual; this skill
says where to look and how to use Hyperfide well.

## Start with context

```sh
hyperfide-platform status --json
```

- `hyperfide-platform guide` prints the concepts and the chapter index. `hyperfide-platform guide <chapter>`
  is the full reference for one area.
- `hyperfide-platform guide commands <group>` prints every command in a group with its options.
  `hyperfide-platform <command> --help` shows current flags and defaults.
- references/command-index.md lists every core command path and alias.

## Find the chapter

| Task                                                                    | Read                           |
| ----------------------------------------------------------------------- | ------------------------------ |
| Spawn, hand off, or fork threads; edit a sent message                   | `hyperfide-platform guide threads`             |
| List, inspect, wait on, or open threads                                 | `hyperfide-platform guide thread-inspection`   |
| Message threads, answer interactions, manage queues                     | `hyperfide-platform guide thread-messaging`    |
| Stop, clear, compact, retry, archive, or delete threads                 | `hyperfide-platform guide thread-lifecycle`    |
| Worktree setup hooks, environment inspection, commits, pull requests    | `hyperfide-platform guide environments`        |
| Enroll, create, update, suspend, or remove machines; move the server    | `hyperfide-platform guide machines`            |
| Projects, sources, attachments, project files                           | `hyperfide-platform guide projects`            |
| Providers, models, service tiers, custom models                         | `hyperfide-platform guide providers`           |
| Dev servers and other long-running commands                             | `hyperfide-platform guide terminals`           |
| Settings, keyboard shortcuts, sidebar preferences, themes, files, voice | `hyperfide-platform guide customization`       |
| `AGENTS.md` and skills                                                  | `hyperfide-platform guide agent-configuration` |
| Plugins and marketplaces                                                | `hyperfide-platform guide plugins`             |
| Scheduled work                                                          | the `automations` skill        |
| Built-in browser tabs                                                   | `hyperfide-platform guide browser`             |
| `--json` output shapes and the error envelope                           | `hyperfide-platform guide json`                |
| Writing theme CSS                                                       | references/theming.md          |

A plugin's commands and settings are documented in that plugin's own skill.
`hyperfide-platform plugin list` shows which commands each plugin contributes.

## Command habits

- Resolve names and IDs with a list or show command before mutation.
- Pass the project explicitly. Pass an environment or machine selector when the
  default host is uncertain, and query provider models on the machine that will
  run the thread.
- Keep file paths on the machine that owns the selected workspace.
- Use `--json` when output controls later work. Parse stdout only: a failure
  prints the error envelope on stdout and the message on stderr, so `2>&1`
  corrupts the JSON.
- Read the whole error before running `--help`; it names the missing flag with
  the current ID filled in.
- Pass long or multi-line text with `--message-file <path>` or
  `--prompt-file <path>` (`-` reads stdin). Inside double quotes the shell runs
  backticks and `$(...)` before Hyperfide sees the text.
- Prefer non-interactive commands. Pass `--yes` only for a destructive command
  the user confirmed.
- Inspect real status, logs, and diffs instead of assuming.
- Examples use POSIX shell syntax. In PowerShell, read an environment variable
  as `$env:NAME`, separate commands with `;`, and continue a line with a
  backtick.

## Working with threads

- Give each task one clear owner. Spawn independent tasks separately.
- Give spawned threads clear prompts: objective, constraints, expected
  deliverable, validation to perform, and what to report back.
- Let threads work. Do not poll with shell sleeps or repeated log and status
  reads; use `hyperfide-platform thread wait <thread-id>` when you must block.
- `hyperfide-platform thread tell` steers the active turn by default. Steer for a wrong
  direction, a hard stop, or a critical clarification; use `--mode queue` for
  non-urgent follow-ups. A send reported as `queued` is not a failure; do not
  resend it.
- For a review or fix pipeline, spawn the follow-up with
  `--environment <environment-id>` from `hyperfide-platform thread show <thread-id> --json` so
  it sees the same files.
- To check whether a thread ever received a message, search
  `hyperfide-platform thread log <thread-id> --all`, not the default page.
- Before retrying a failed thread, read `hyperfide-platform thread show <thread-id> --json` and
  `hyperfide-platform thread log <thread-id>`. Treat a thread the user stopped as intentionally
  stopped unless they ask you to continue.

## Safety

- Never move the server, abandon a move, or unlock an old copy without the
  user's explicit confirmation in this conversation. Run
  `hyperfide-platform server move --to <machine> --check`, show them the checklist, and run it
  without `--check` only after they confirm. Never pass `--yes` for them.
- Only the owner can change a machine's permission limit, in the app. Read it
  with `hyperfide-platform machine show <id-or-name> --json` and ask the user to change it.
- Keep secrets out of command arguments, logs, and transcripts.
  `hyperfide-platform machine env set` reads its value from stdin, and enrollment bundles travel
  through a private file or environment variable. Machine and environment inputs
  are persisted and readable, so they never carry credentials. Do not print
  `serverHeaders`.
- Install a registry skill or plugin by its ID. Never infer an install source
  from a display name.

## Common checks

```sh
hyperfide-platform project list --json
Hyperfide machine list --json
Hyperfide environment providers --json
Hyperfide provider list --environment "$HYPERFIDE_ENVIRONMENT_ID" --json
hyperfide-platform thread show "$HYPERFIDE_THREAD_ID" --json
hyperfide-platform thread context --self --json
Hyperfide environment status "$HYPERFIDE_ENVIRONMENT_ID" --json
hyperfide-platform plugin list --json
Hyperfide skill list --environment "$HYPERFIDE_ENVIRONMENT_ID" --json
```

## Completion

Confirm the command result and any affected thread, environment, plugin, or
remote service. Report the stable ID or URL that the user needs next.
