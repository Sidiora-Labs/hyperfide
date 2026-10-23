#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
export CG="$ROOT/cg"
bash tests/integration/14_vscode.sh
bash tests/integration/19_acp.sh
npm --prefix editors/vscode test
node <<'JS'
const assert = require('node:assert/strict');
const { contributes } = require('./editors/vscode/package.json');
assert.equal(contributes.views, undefined, 'workflow views must be absent');
assert.equal(contributes.viewsContainers, undefined, 'workflow containers must be absent');
assert.equal(contributes.viewsWelcome, undefined, 'workflow welcome sections must be absent');
for (const command of contributes.commands) {
    assert.match(command.command, /^hyperfide\.open(?:Task|File)InPlatform$/);
}
JS
for file in tasks.js fleet.js sandboxes.js agents.js acp.js agentpanel.html needs.js issues.js memories.js memorypanel.html refresh.js serve.js; do
    test -z "$(git ls-files -- "editors/vscode/$file")" || {
        echo "Removed extension module still tracked: $file" >&2
        exit 1
    }
done
