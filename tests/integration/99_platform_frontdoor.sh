#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
make -C "$REPO" cg
CG="$REPO/cg"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/.git" "$TMP/repo/nested" "$TMP/bin"
cat > "$TMP/bin/hyperfide-platform" <<'STUB'
#!/bin/sh
printf 'root=%s\nenv=%s\n' "$HYPERFIDE_REPO_ROOT" "$HYPERFIDE_FRONTDOOR_TEST"
printf '<%s>\n' "$@"
printf 'platform stderr\n' >&2
/bin/cat
exit 23
STUB
chmod +x "$TMP/bin/hyperfide-platform"
export HYPERFIDE_FRONTDOOR_TEST=inherited
export HYPERFIDE_REPO_ROOT=incorrect
cd "$TMP/repo/nested"
check() {
    local rc=0
    printf 'stdin\n' | env PATH="${TEST_PATH:-$PATH}" "$CG" platform 'two words' '' --json --help --branch literal > "$TMP/out" 2> "$TMP/err" || rc=$?
    test "$rc" = 23
    printf 'root=%s\nenv=inherited\n<two words>\n<>\n<--json>\n<--help>\n<--branch>\n<literal>\nstdin\n' "$TMP/repo" > "$TMP/expected"
    cmp "$TMP/out" "$TMP/expected"
    printf 'platform stderr\n' > "$TMP/expected"
    cmp "$TMP/err" "$TMP/expected"
}
export HYPERFIDE_PLATFORM_BIN="$TMP/bin/hyperfide-platform"
check
mkdir -p "$TMP/repo/apps/cli/bin"
printf '#!/bin/sh\nexit 91\n' > "$TMP/repo/apps/cli/bin/hyperfide-platform"
chmod +x "$TMP/repo/apps/cli/bin/hyperfide-platform"
check
cp "$HYPERFIDE_PLATFORM_BIN" "$TMP/repo/apps/cli/bin/hyperfide-platform"
HYPERFIDE_PLATFORM_BIN="$TMP/missing" check
unset HYPERFIDE_PLATFORM_BIN
check
rm "$TMP/repo/apps/cli/bin/hyperfide-platform"
TEST_PATH="$TMP/bin" check
rc=0
PATH="$TMP/empty" "$CG" platform --help > "$TMP/out" 2> "$TMP/err" || rc=$?
test "$rc" = 69
test ! -s "$TMP/out"
grep -F 'CLI unavailable: checked HYPERFIDE_PLATFORM_BIN (unset)' "$TMP/err"
grep -F "$TMP/repo/apps/cli/bin/hyperfide-platform" "$TMP/err"
grep -F 'hyperfide-platform on PATH' "$TMP/err"
"$CG" --help | grep -F 'platform'
echo 'platform front door: passed'
