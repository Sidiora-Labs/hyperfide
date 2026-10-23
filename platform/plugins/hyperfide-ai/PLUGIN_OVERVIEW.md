Thread titles, commit messages, and voice input from hyperfide platform cloud, included with your hyperfide platform account.

## What you get

- A `hyperfide platform cloud` AI service for thread titles (branch names follow the title), commit messages, and voice input.
- On by default once you sign in. Turn it off with `hyperfide platform ai off`, or disable this plugin.
- Automatic tries hyperfide platform cloud first, then other compatible registered services by plugin id and service id in lexicographic order. The microphone appears once an enabled service is ready.
- Today's usage against your daily limit with `hyperfide platform ai usage`.

## How it works

Hosted accounts are disabled, so this plugin reports cloud AI as unavailable
without contacting a hosted service. Configure a local AI provider instead.

## For agents

`hyperfide platform ai status` and `hyperfide platform ai usage` report readiness and spend. `hyperfide platform ai off` turns hyperfide platform cloud off and `hyperfide platform ai on` turns it back on; turn it on only when the user asks. `hyperfide platform settings ai-services set <task> hyperfide platform` picks hyperfide platform cloud for a task, and `hyperfide platform voice transcribe <file>` tests voice input.

## Requirements

A hyperfide platform account (`hyperfide platform account login`).
