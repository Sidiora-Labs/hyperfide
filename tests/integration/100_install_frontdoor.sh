#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${CG:-"$REPO/hyperfide"}
BIN=$(realpath "$BIN")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/work"
cp "$BIN" "$TMP/bin/hyperfide"
cd "$TMP/work"
"$TMP/bin/hyperfide" install --help > "$TMP/help"
grep -q -- '--envelope PATH' "$TMP/help"
test ! -e .codegraph
"$TMP/bin/hyperfide" help install > "$TMP/help-alias"
cmp "$TMP/help" "$TMP/help-alias"
status=0
"$TMP/bin/hyperfide" install > "$TMP/out" 2> "$TMP/err" || status=$?
test "$status" = 64
grep -q 'usage: hyperfide install' "$TMP/err"
status=0
"$TMP/bin/hyperfide" install --package package.kvx --source-config .neron --envelope admission.json > "$TMP/out" 2> "$TMP/err" || status=$?
test "$status" = 69
grep -q 'prebuilt installer is unavailable' "$TMP/err"
test ! -e .codegraph
