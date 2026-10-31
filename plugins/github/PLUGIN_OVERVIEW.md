See the open issues and pull requests of your repositories inside hyperfide platform. Hand one to an agent with one click.

## What you get

- A GitHub panel with Issues and Pull requests tabs across every tracked repository. It has a repository filter and a New issue form.
- Issue details: body, comments, a comment box, and editing of status, assignee, and labels.
- Send agent on an issue, or Review with agent on a pull request. hyperfide platform starts a thread in the repository's project and links it from the item.
- Mentions. Type `@` or `#` in any composer to attach an issue or pull request. Its title, body, and state go to the agent at send time.

## How it works

The plugin tracks every hyperfide platform project whose checkout has a GitHub `origin` remote. Add more repositories in the Extra repositories setting as a comma-separated `owner/repo` list. Choose a Default project for repositories that are not attached to a project. A background service refreshes the cache at startup, then waits 15 minutes after each completed sync to reduce background GitHub traffic. Press Refresh in the panel to update now.

## For agents

The `hyperfide platform github` command lists cached data. Use `hyperfide platform github repos`, `hyperfide platform github issues [owner/repo]`, `hyperfide platform github prs [owner/repo]`, or `hyperfide platform github sync`. Every command accepts `--json`, and `hyperfide platform github --help` or `hyperfide platform github <command> --help` prints the arguments and options and exits 0.

## Requirements

The GitHub CLI must be installed and signed in with `gh auth login`. See https://cli.github.com for installation. The plugin uses your `gh` session and stores no tokens. Until `gh auth status` passes, the plugin reports that it needs configuration.
