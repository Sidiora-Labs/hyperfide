Tell every agent on this hyperfide platform host the things you would otherwise repeat in each thread. Examples: your coding conventions, the tools you prefer, and the projects it should know about.

## What you get

- One text field in Settings, up to 4,096 characters.
- The text is added to the instructions of every agent task on this host, for every provider and every project.
- Changes apply to the next task. You do not restart anything.

## How it works

Write the instructions as plain text or Markdown. Leave the field empty to add nothing. hyperfide platform appends your text to the instructions it already gives the agent.

## For agents and scripts

Use the `hyperfide platform instructions` command:

- `hyperfide platform instructions get` prints the current text.
- `hyperfide platform instructions set <text...>` replaces it.
- `hyperfide platform instructions clear` removes it.

Add `--json` for machine-readable output.
