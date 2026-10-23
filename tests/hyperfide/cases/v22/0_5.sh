#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 - <<'PY'
import re
import subprocess
from pathlib import Path

# Match reporting integrations, not ordinary path segments or transitive schema validators.
patterns = re.compile(
    r'posthog|@segment/(?:analytics|snippet)|segment\.(?:io|com)|analytics[._-]?write[._-]?key|'
    r'(?-i:\b[A-Z][A-Z0-9_]*TELEMETRY[A-Z0-9_]*\b)|'
    r'\b(?:telemetryEnabled|initiatorTelemetry)\s*[:=]|--(?:no-)?telemetry',
    re.IGNORECASE,
)
violations = []
for name in subprocess.check_output(['git', 'ls-files', 'platform/'], text=True).splitlines():
    path = Path(name)
    # 0.7 owns the historical changelog and dependency cleanup.
    if name == 'platform/CHANGELOG.md' or 'node_modules' in path.parts:
        continue
    if not path.is_file() or path.name.startswith('.env'):
        continue
    try:
        content = path.read_text()
    except UnicodeError:
        continue
    if patterns.search(content):
        violations.append(name)
assert not violations, 'Third-party reporting remains in: ' + ', '.join(violations)
print('Telemetry scan passed')
PY
pnpm -C platform exec turbo run typecheck --filter=./packages/config --filter=./packages/domain --filter=./packages/sdk --filter=./packages/server-contract --filter=./packages/scripts --filter=./packages/hyperfide-app --filter=./apps/server --filter=./apps/app
pnpm -C platform exec turbo run test --filter=./packages/hyperfide-app --filter=./packages/config --filter=./packages/domain --filter=./packages/sdk --filter=./packages/server-contract
# 0.7 owns these tests: their removed platform/.github fixtures or zip dependency.
# Keep the exclusions by file name, and run every remaining scripts/server test.
excludes=()
for name in actions-api.test.mjs ci-bun.test.mjs ci-fuse.test.mjs ci-health.test.mjs ci-performance.test.mjs ci-selection.test.mjs ci-workflow.test.ts pr-approval-workflows.test.ts; do
  excludes+=(--exclude "**/$name")
done
pnpm -C platform exec turbo run test --filter=./packages/scripts --filter=./apps/server -- --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000 "${excludes[@]}"
