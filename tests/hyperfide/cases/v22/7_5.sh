#!/usr/bin/env bash
# 7.5: the owner regenerated CHANGELOG.md and CODEMAP.md at the docs closure.
# CHANGELOG.md carries a 2.2.0 section and CODEMAP.md is newer than the last
# commit touching platform/ or src/. No agent edits either file.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
fail() { echo "FAIL $*" >&2; exit 1; }

grep -Eq '^## \[?2\.2\.0\]?( |$)' CHANGELOG.md || fail "CHANGELOG.md has no 2.2.0 section"
echo "changelog: 2.2.0 section present"

code_at=$(git log -1 --format=%ct -- platform src)
[ -n "$code_at" ] || fail "no commit touches platform/ or src/"
if ! git diff --quiet -- CODEMAP.md; then
  echo "codemap: regenerated in the working tree (newer than $(git log -1 --format=%h -- platform src))"
  exit 0
fi
map_at=$(git log -1 --format=%ct -- CODEMAP.md)
[ -n "$map_at" ] || fail "CODEMAP.md has no commit"
[ "$map_at" -ge "$code_at" ] || fail "CODEMAP.md ($(git log -1 --format=%h -- CODEMAP.md)) is older than the last platform/src commit ($(git log -1 --format=%h -- platform src))"
echo "codemap: $(git log -1 --format=%h -- CODEMAP.md) is at least as new as $(git log -1 --format=%h -- platform src)"
