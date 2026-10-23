---
name: claude-code-provider
description: "Configure or troubleshoot HYPERFIDE-specific Claude Code provider settings and session behavior."
---

# Claude Code provider

Read settings with `hyperfide-platform plugin config provider-claude-code`; change a declared key
with `hyperfide-platform plugin config provider-claude-code set <key> <value>`.

- `disable1MContext` defaults to `false`. Enable with
  `hyperfide-platform plugin config provider-claude-code set disable1MContext true` to set
  `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (`0` when off). Changes restart the
  thread's Claude process before its next turn, preserving context.
- `chromeEnabled` defaults to `false`. It starts Claude Code with `--chrome` for
  Claude in Chrome tools. The host needs the extension and a claude.ai login.
  A change restarts the thread's Claude process before its next turn, preserving
  context.
- `artifactsEnabled` defaults to `false`. Enable with
  `hyperfide-platform plugin config provider-claude-code set artifactsEnabled true` to set
  `CLAUDE_CODE_ARTIFACT=1`, which gives threads Claude Code's `Artifact`,
  `ArtifactComments`, and `ArtifactData` tools for reading `claude.ai/artifact/`
  links and publishing pages. Claude Code withholds them from SDK sessions
  unless opted in. Claude may publish private pages to claude.ai without asking.
  The claude.ai account's plan and organization policy still decide whether the
  tools load. When off, Hyperfide leaves an inherited `CLAUDE_CODE_ARTIFACT` (shell,
  environment, or `~/.claude/settings.json` `env`) untouched. A change restarts
  the thread's Claude process before its next turn, preserving context.
- Select the Fast service tier in the model picker or pass `--service-tier fast`
  to `hyperfide-platform thread spawn` for supported Opus models. Use
  `hyperfide-platform thread tell --service-tier fast` to change a thread on its next turn;
  `default` turns it off. Fast mode requires eligible Claude access;
  subscription accounts need usage credits. It is billed at premium rates.
  The provider passes the selection as a session-scoped SDK setting, so it
  does not change the user's Claude defaults.
- `sandboxEnabled` defaults to `true`. In Accept Edits and Approve for me modes
  Hyperfide runs Claude Code's Bash commands in its sandbox. Set it to `false` to use
  Claude Code's own command approvals and sandbox settings instead. A change
  restarts the thread's Claude process before its next turn, preserving context.
- Hyperfide passes only `HYPERFIDE_CLAUDE_CODE_EXECUTABLE` and `CLAUDE_CODE_OAUTH_TOKEN` to
  the CLI. Mint the token with `claude setup-token` for machines with no
  interactive login.
- Claude Code's own slash commands, including bundled skills such as
  `/simplify` and `/code-review`, appear in the composer's `/` menu,
  `hyperfide-platform project commands`, and `hyperfide-platform thread commands`. The provider reads them from
  Claude Code for the project folder without sending a prompt. With **No project**
  selected, it uses an empty catalog folder on the selected machine so global
  commands appear before a workspace exists. Each thread refreshes them when a
  turn starts. Commands for settings Hyperfide manages (such as
  `/model`, `/config`, `/fast`), terminal-only commands (such as `/doctor`),
  and Hyperfide's own skills are left out.
- Structured plan, message editing, and compaction are supported through the
  corresponding `hyperfide-platform thread` commands. Unlisted model IDs are accepted by the
  provider; verify actual availability on the target host.

Inspect the thread and provider state after a change; do not restart unrelated
threads or change settings merely to answer a question.

Automatic context breakdowns run in a separate, non-persisted fork of the saved
conversation. Reporting never sends prompts or control requests to the live
Claude session. A timeout, replacement, or thread stop closes the reporter;
the live conversation does not wait for reporting or restart because of it.
