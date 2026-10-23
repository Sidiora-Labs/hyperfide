# Hyperfide cloud AI

## Setup and entry points

Settings → AI services; Settings → Plugins → hyperfide platform cloud AI (enable/disable only;
there is no settings page); hyperfide platform ai --help. Needs a signed-in hyperfide platform account
`OPENROUTER_API_KEY` in the cloud-dev environment. hyperfide platform cloud is on in a fresh
store.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/hyperfide-ai/package.json`
- `plugins/hyperfide-ai/src/server.ts`
- `apps/ai-gateway/src/gateway.ts`

## Feature recipes

## Evidence and cleanup
