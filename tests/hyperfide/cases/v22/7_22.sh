#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
step() {
  local name="$1"; shift
  local start=$SECONDS rc=0
  "$@" || rc=$?
  echo "7.22: $name $((SECONDS-start))s exit=$rc"
  return "$rc"
}
step typecheck pnpm -C platform --filter @hyperfide/desktop typecheck
step tests pnpm -C platform --filter @hyperfide/desktop test
step build pnpm -C platform exec turbo run build --filter=@hyperfide/desktop
step 'login handler registered' grep -rqE 'on\(\s*"login"' platform/apps/desktop/src
step 'probe reports auth-required' grep -qE '"auth-required"' platform/apps/desktop/src/server-probe.ts
step 'credentials stored with safeStorage' grep -rqE 'safeStorage' platform/apps/desktop/src
step 'basic credentials dialog exists' bash -c 'ls platform/apps/desktop/src/*credential*.ts >/dev/null 2>&1 || ls platform/apps/desktop/src/*basic-auth*.ts >/dev/null 2>&1'
step 'no password reaches a log call' bash -c '! grep -rnE "(log|warn|error|info)[A-Za-z]*\([^)]*\bpassword\b" platform/apps/desktop/src --include=*.ts | grep -v "\.test\.ts"'
step 'readme documents basic auth' grep -qiE 'basic auth' platform/apps/desktop/README.md
