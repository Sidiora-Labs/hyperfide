# Tasks

Tasks is a Linear-style tracker inside hyperfide platform for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Install

Install Tasks from the official plugins that HYPERFIDE includes:

```sh
hyperfide platform plugin install tasks
```

The plugin adds the Tasks sidebar panel, the `hyperfide platform tasks` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin with `hyperfide platform plugin install tasks`. Then use the `hyperfide platform tasks` CLI
to create a tracker project. Link it to the hyperfide platform project where delegated agents
will run:

```sh
hyperfide platform tasks project create \
  --name "Product" \
  --prefix PROD \
  --link-hyperfide-project proj_your_hyperfide_project

hyperfide platform tasks create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

hyperfide platform tasks list --project PROD
hyperfide platform tasks show PROD-1
hyperfide platform tasks preset list
hyperfide platform tasks delegate PROD-1 --preset "GPT-5.6 · high"
```

When the CLI runs inside a linked hyperfide platform project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the hyperfide platform
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Tasks only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`hyperfide platform tasks comment PROD-1 --body "New context" --notify`.
The app and Tasks RPC return the saved comment before notification delivery,
with `notifiedCount` initially 0. Comment change events publish immediately and
again when delivery finishes. The CLI waits for delivery, so `--notify --json`
includes the final `notifiedCount`. Failed delivery leaves that count at 0.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

## CLI reference

Run `hyperfide platform tasks --help` or `hyperfide platform tasks <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a hyperfide platform
project id (`proj_...`); `hyperfide platform tasks project list` shows both columns. Repeatable
options (`--label`, `--status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine, otherwise the server's
machine; pass `--machine <id-or-name>` to target another enrolled machine.

| Command                                        | Purpose                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hyperfide platform tasks status`                              | Show the installed Tasks plugin name and version. Task workflow status lives on `hyperfide platform tasks list --status` and `hyperfide platform tasks update --status`.   |
| `hyperfide platform tasks project create\|list\|show\|update`  | Manage tracker projects, folders, colors, prefixes, and hyperfide-project links.                                                                  |
| `hyperfide platform tasks folder create\|list\|update\|delete` | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `hyperfide platform tasks create`                              | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `hyperfide platform tasks list`                                | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.        |
| `hyperfide platform tasks show <key-or-id>`                    | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `hyperfide platform tasks update <key-or-id>`                  | Update status, priority, title, description, due date, or labels.                                                                          |
| `hyperfide platform tasks move <key-or-id>`                    | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `hyperfide platform tasks comment <key-or-id>`                 | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `hyperfide platform tasks attachment add\|get\|list\|remove`   | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `hyperfide platform tasks preset list\|create\|update\|delete` | Manage reusable agent execution presets.                                                                                                   |
| `hyperfide platform tasks delegate <key>`                      | Start and attach a new agent thread using a preset.                                                                                        |
| `hyperfide platform tasks attach <key-or-id>`                  | Attach the current hyperfide platform thread to a task when it was not delegated from Tasks.                                                               |
| `hyperfide platform tasks detach <key-or-id>`                  | Detach the current hyperfide platform thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `hyperfide platform tasks threads <key>`                       | List the hyperfide platform threads attached to a task: live threads first, newest first.                                                                  |
| `hyperfide platform tasks label create\|list\|delete`          | Manage project-scoped labels.                                                                                                              |
| `hyperfide platform tasks seed-demo --yes`                     | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

## Agents, delegation, and presets

Linking a Tasks project to a hyperfide platform project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

Delegation creates a worker thread in the linked hyperfide platform project, attaches that
thread to the task, and advances a `backlog` or `todo` task to `in_progress`.
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Tasks
skill tells it to inspect the task, leave substantive milestone comments,
attach artifacts, and move completed work to `in_review`.

If work begins outside the Delegate action, the agent can associate its current
thread with `hyperfide platform tasks attach KEY`. The inverse is `hyperfide platform tasks detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. The task
page and `hyperfide platform tasks threads` list live threads before completed or failed ones,
newest first.

## Task mentions

Type `@` in the hyperfide platform composer and select **Tasks** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Tasks linked to the current hyperfide platform project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](hyperfide-task://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Tasks skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add notifications and an inbox for task activity.
- Add a command palette entry for Tasks to cmd-K.
