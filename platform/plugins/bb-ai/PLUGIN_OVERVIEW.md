Thread titles, commit messages, and voice input from hyperfide platform cloud, included with your hyperfide platform account.

## What you get

- A `hyperfide platform cloud` AI service for thread titles (branch names follow the title), commit messages, and voice input.
- On by default once you sign in. Turn it off with `hyperfide platform ai off`, or disable this plugin.
- Automatic tries hyperfide platform cloud first, then other compatible registered services by plugin id and service id in lexicographic order. The microphone appears once an enabled service is ready.
- Today's usage against your daily limit with `hyperfide platform ai usage`.

## How it works

Sign in with your hyperfide platform account. When a task uses hyperfide platform cloud, hyperfide platform sends its prompt to hyperfide.app, which forwards it to OpenRouter model providers with zero data retention: the text of a thread's first prompt for titles, the changed files with a diff excerpt for commit messages, and the recording for voice input. hyperfide platform stores your daily usage totals and, for 30 days, metadata about each request such as its time, model, token counts, and cost. It never stores prompts, recordings, or replies. Turn hyperfide platform cloud off with `hyperfide platform ai off`; your hyperfide platform account stays signed in.

## For agents

`hyperfide platform ai status` and `hyperfide platform ai usage` report readiness and spend. `hyperfide platform ai off` turns hyperfide platform cloud off and `hyperfide platform ai on` turns it back on; turn it on only when the user asks. `hyperfide platform settings ai-services set <task> hyperfide platform` picks hyperfide platform cloud for a task, and `hyperfide platform voice transcribe <file>` tests voice input.

## Requirements

A hyperfide platform account (`hyperfide platform account login`).
