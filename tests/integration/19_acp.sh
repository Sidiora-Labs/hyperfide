#!/usr/bin/env bash
# ACP now lives in the platform. Keep this integration-suite entry as a
# regression check for the extension boundary and its platform commands.
. "$(dirname "$0")/../lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

for file in acp.js agents.js agentpanel.html; do
    test -z "$(git -C "$ROOT" ls-files -- "extensions/vscode/$file")" \
        || fail "Removed extension ACP module still tracked: $file"
done

# Exercise activation, index status, URL configuration and encoded task/file
# links through the current extension command suite.
bash "$ROOT/tests/integration/14_vscode.sh" commands

echo "PASS 19_acp.sh (platform handoff)"
