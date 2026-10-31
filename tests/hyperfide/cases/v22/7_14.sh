#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
log_dir=$(mktemp -d "${TMPDIR:-/tmp}/hyperfide-7_14.XXXXXX")
trap 'rm -rf "$log_dir"' EXIT
run_check() {
  local name=$1 started=$SECONDS code=0
  shift
  "$@" >"$log_dir/$name.log" 2>&1 || code=$?
  printf '7.14: %s %ss exit %s\n' "$name" "$((SECONDS - started))" "$code"
  return "$code"
}
result=0
run_check typecheck pnpm -C plugins/hyperfide-spec typecheck || result=1
run_check tests pnpm -C plugins/hyperfide-spec test || result=1
run_check bundled-plugins pnpm exec turbo run build --filter=@hyperfide/bundled-plugins... || result=1
exit "$result"
