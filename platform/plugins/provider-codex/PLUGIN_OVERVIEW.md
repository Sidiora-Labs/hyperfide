Start a thread, pick Codex, and let it write and review code in your repository from hyperfide platform. The plugin drives the Codex CLI on the host machine. It streams the agent's work into the hyperfide platform timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus plan and goal actions in the composer.
- Reasoning levels from Low to Ultra. Ultra adds automatic task delegation.
- A service tier picker that offers the tiers Codex reports for the selected model (Fast, and Ultrafast where the account has it).
- A Daybreak switch in the model picker for accounts that have Daybreak, usable with any model that supports it.
- Checkpoint forks, manual compaction, thread rename, and thread archive.
- Question cards for the questions Codex asks while it keeps working. Your answer reaches Codex as a message.
- Codex skills from your home directory and project, listed next to hyperfide platform skills.
- Health, usage, and install status on each host, with an install or update action.
- A Codex AI service for inference and voice that other hyperfide platform features can use.

## Settings

- `Codex memory`: let Codex recall and create memories from hyperfide platform threads.
- `Disable provider subagents`: stop native subagents so the agent delegates through hyperfide platform.

## Requirements

- Install the Codex CLI (`codex`) on the host machine, version 0.136.0 or newer. The plugin can run the npm install for you.
- Sign in with `codex login` on that machine. A ChatGPT account or an OpenAI API key both work.
- Usage limits show only for ChatGPT accounts.
