---
kind: instruction
title: hyperfide-platform Guide — Agent Configuration
summary: User and workspace files that customize agent instructions and skills.
intent: Document the user and workspace files that shape agent behavior for threads.
editingNotes: Keep accurate against the server's agent-instructions reader and skill loader.
---
Agent configuration

hyperfide-platform reads agent configuration from the app data dir and from a project's .hyperfide/
directory. These files shape how agents behave in provider-backed threads.

User instructions (<dataDir>/AGENTS.md):

  Add an AGENTS.md file to the hyperfide-platform data dir (usually ~/.hyperfide/AGENTS.md) to give
  every provider-backed thread across all projects default user-level
  instructions. hyperfide-platform reads <dataDir>/AGENTS.md and appends its contents to the
  thread system prompt for all providers when a provider session starts.

Workspace instructions (.hyperfide/AGENTS.md):

  Add a .hyperfide/AGENTS.md file to a workspace to give every thread that runs there
  repo-specific instructions. hyperfide-platform reads <workspace>/.hyperfide/AGENTS.md and appends its
  contents to the thread system prompt for all providers, after any
  <dataDir>/AGENTS.md instructions, when a provider session starts. Track it with
  git so fresh managed worktrees include it.

  Only the plural AGENTS.md is read, only from the exact data-dir and
  workspace-root .hyperfide/ locations above (hyperfide-platform does not walk parent directories), and
  an empty file is ignored. This is Hyperfide's own provider-agnostic instruction
  injection, separate from provider-native instruction files. Codex reads a
  repo-root AGENTS.md. Claude Code 2.1.277 and later also reads AGENTS.md when
  no project or ancestor CLAUDE.md or CLAUDE.local.md takes precedence. Older
  Claude Code versions and sessions without its built-in AGENTS.md support
  still require CLAUDE.md.

Skills (.hyperfide/skills/):

  A skill is a reusable instruction file that hyperfide-platform injects into a thread and
  exposes to the agent as a slash command. Place project skills under
  .hyperfide/skills/<name>/SKILL.md in a workspace. Each SKILL.md has YAML frontmatter
  with `name` (lowercase, hyphenated, matching the directory) and `description`,
  followed by the instruction body.

  hyperfide-platform resolves skills from three sources, in increasing precedence:

    plugin     Skills from enabled plugins, including the bundled HYPERFIDE guide.
    user       <dataDir>/skills (e.g. ~/.hyperfide/skills).
    project    <workspace>/.hyperfide/skills.

  A project skill overrides a user or plugin skill with the same name. Two
  skills with the same name within one source collide and are both dropped.

  Use `hyperfide-platform skill list` to inspect installed and discovered skills and copy the
  opaque skill ID. `hyperfide-platform skill show|files <skill-id>` reads that exact skill;
  `hyperfide-platform skill show <skill-id> --json` returns the revision required by `hyperfide-platform skill
  update <skill-id> --revision <sha256>`. `hyperfide-platform skill delete <skill-id>` and
  update are restricted to editable, user-owned skills. These workspace-scoped
  commands default to `HYPERFIDE_PROJECT_ID`, then the personal project; pass
  `--project` or `--environment` when a different workspace is required.

  Use `hyperfide-platform skill search [query]` to browse skills.sh (no query lists what is
  trending; `--page` starts at 0 and `--per-page` defaults to 24). JSON
  `installs` counts the `ranking` window; `lifetimeInstalls` may be null. Use `hyperfide-platform skill registry detail
  <registry-skill-id>` to inspect metadata and the bounded file preview, and
  `hyperfide-platform skill install <registry-skill-id>` to install that canonical registry
  identity into hyperfide-platform user skills. Registry commands are server-wide and do not
  accept workspace selectors.

  Use `hyperfide-platform skill install-cli-skills` to copy Hyperfide's built-in CLI skills into a
  machine's global agent skill roots (`~/.agents/skills` and
  `~/.claude/skills`) so agents running outside hyperfide-platform can drive it. It installs on
  every connected persistent machine unless you pass `--machine <id-or-name>`
  (repeatable; required for a sandbox) (Settings → Skills has the same action). Machines install
  independently, so the command reports each machine's outcome and exits
  non-zero if any failed. The install replaces a previously installed copy of
  the same skill and leaves other skills alone. `hyperfide-platform skill cli-skills-status`
  reports whether each machine is installed, out of date, missing, or unknown
  (disconnected or unreachable).

  Use the skill-creator skill to author and iterate on skills.

HYPERFIDE guide plugin:

  The enabled-by-default HYPERFIDE guide plugin owns the HYPERFIDE introduction and the
  hyperfide-cli, hyperfide-plugin-authoring, skill-creator, and submit-a-plugin skills. Settings → Installed
  plugins → HYPERFIDE guide exposes introduction, a master skills switch, and one
  switch per skill. All default to true. Use:

    hyperfide-platform plugin config hyperfide-guide set introduction false
    hyperfide-platform plugin config hyperfide-guide set skills false
    hyperfide-platform plugin config hyperfide-guide set hyperfideCli false
    hyperfide-platform plugin config hyperfide-guide set pluginAuthoring false
    hyperfide-platform plugin config hyperfide-guide set skillCreator false
    hyperfide-platform plugin config hyperfide-guide set submitPlugin false

  Changes apply when agent configuration is next assembled. They do not erase
  existing conversation text or disable independently installed copies.
