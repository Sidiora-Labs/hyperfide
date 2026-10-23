---
name: mcp
description: Connect ChatGPT, Claude or another MCP client to this Hyperfide, and list or disconnect the apps that have access.
---

# Hyperfide MCP server

The MCP server plugin lets an MCP client control this hyperfide. It is off by default. Turn it on in Settings → Plugins or with `hyperfide-platform plugin enable hyperfide--mcp`.

## Addresses

`Hyperfide mcp status [--json]` prints both addresses.

- **Remote**: `https://<your hyperfide-platform connect address>/mcp`. This needs a signed-in Hyperfide account (`Hyperfide account login`) and hyperfide-platform connect. Add it as a custom connector in ChatGPT or Claude. The app sends you to a Hyperfide account page where you approve access for this hyperfide.
- **Local**: `http://127.0.0.1:<port>/api/v1/plugins/hyperfide--mcp/http/mcp`. Apps on the same machine can use it without signing in. It has the same trust as the `Hyperfide` CLI on that machine. Requests from web pages are refused.

## What approving an app grants

Access is all or nothing. An approved app can run any `Hyperfide` command: it can see everything in this Hyperfide, and it can start and message agents and open terminals, which run commands and change files on the machines this Hyperfide controls. Approve only apps you trust, and disconnect the ones you no longer use.

## Connected apps

- `Hyperfide mcp clients [--json]` lists the remote apps with access to this hyperfide.
- `Hyperfide mcp revoke <grant-id> [--json]` disconnects one. The app loses access within about a minute.

The Hyperfide account dashboard lists the same apps under Connected apps.

## Tools the client sees

- `search` finds `Hyperfide` commands for a task.
- `read` runs a JavaScript snippet that can call only commands that inspect hyperfide. It is marked read-only so the app can run it without asking you each time; it is not a separate permission.
- `run` runs a JavaScript snippet that can call any `Hyperfide` command.

Snippets call `hyperfide.cli([...argv])` or `hyperfide.json([...argv])` and run in a sandbox on the hyperfide-platform server with no network or file access. A snippet is stopped after 25 seconds, after 3 seconds of computation, or when it runs out of its 64 MB of memory, and runs at most 4 `Hyperfide` commands at a time.

Three commands cannot run over MCP because they need an interactive terminal or never exit: `Hyperfide terminal attach`, `hyperfide-platform plugin dev`, and `Hyperfide browser watch`.

## Protocol

The endpoint speaks MCP 2026-07-28 and also answers 2025-era clients. It is stateless: there are no sessions.
