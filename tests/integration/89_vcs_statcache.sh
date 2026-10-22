#!/usr/bin/env bash
# The built-in snapshot store (hyperfide-v21 3.9): a stat cache keyed on
# path, size and mtime means an unchanged tree re-snapshots without reading
# a single file, and in distributed mode (25.3) cg status and cg state mark
# the store non-authoritative. No snapshot commit is required to see either.
. "$(dirname "$0")/../lib.sh"
unset HYPERFIDE_MODE CG_MODE CODIFY_MODE HYPERFIDE_AUTHORITY_DESCRIPTOR \
      CG_AUTHORITY_DESCRIPTOR CODIFY_AUTHORITY_DESCRIPTOR

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
"$CG" init >/dev/null

# jq-free field reads from `status --json`
store() { "$CG" status --json | python3 -c '
import json, sys
s = json.load(sys.stdin)["store"]
keys = sys.argv[1:]
v = s
for k in keys:
    v = v[k]
print(json.dumps(v) if isinstance(v, bool) else v)' "$@"; }

# The read counter: `cg status` prints "snapshot: N files, H hashed, C
# unchanged by stat cache", where H counts the files actually opened.
# counts -> "N H C"
counts() {
    "$CG" status | sed -n 's/^snapshot: \([0-9]*\) files, \([0-9]*\) hashed, \([0-9]*\) unchanged.*/\1 \2 \3/p'
}

# Every file older than the snapshot's start second, so none is racily clean.
backdate() {
    find . -path ./.codegraph -prune -o -path ./.hyperfide -prune -o \
        -type f -exec touch -d '2 minutes ago' {} +
}
backdate

# ---- first snapshot reads every file and fills the cache
rm -rf .codegraph/statcache
read -r files hashed cached <<<"$(counts)"
[ "${files:-0}" -gt 3 ] || fail "expected a non-trivial tree, got '$files' files"
[ "$hashed" -eq "$files" ] && [ "$cached" -eq 0 ] ||
    fail "a cold snapshot must read every file ($hashed of $files)"

# ---- an unchanged tree re-snapshots without reading any file
read -r f2 hashed cached <<<"$(counts)"
[ "$f2" -eq "$files" ] || fail "file count changed ($f2 vs $files)"
[ "$hashed" -eq 0 ] || fail "unchanged tree re-read $hashed files"
[ "$cached" -eq "$files" ] ||
    fail "unchanged tree not served from the stat cache ($cached of $files)"

# ---- a commit through a warm cache still stores every blob (status only
# hashed them), so its tree loads and the tree reads clean against it
"$CG" commit -m "snapshot through the stat cache" >/dev/null
"$CG" log -n 1 | grep -q "snapshot through the stat cache" || fail "commit missing"
out="$("$CG" status)"
has "$out" "working tree clean"
has "$out" "0 hashed"

# Observation, not timing: swap a file's bytes for different bytes of the
# same size and put its mtime back. A snapshot that read the file would see
# the change; one served by the cache keeps the recorded hash.
victim=src/util.ts
[ -f "$victim" ] || fail "fixture file $victim missing"
cp -p "$victim" "$TMP/ref"
python3 - "$victim" <<'PY'
import sys
p = sys.argv[1]
b = bytearray(open(p, "rb").read())
b[0] = ord("#") if b[0] != ord("#") else ord("/")
open(p, "wb").write(bytes(b))
PY
touch -r "$TMP/ref" "$victim"
cmp -s "$victim" "$TMP/ref" && fail "content swap did not change the bytes"
out="$("$CG" status)"
has "$out" "working tree clean"
has "$out" "0 hashed"

# ---- a changed mtime is noticed and only that file is read
touch "$victim"
out="$("$CG" status --json)"
has "$out" "\"modified\":[\"$victim\"]"
read -r _ hashed _ <<<"$(counts)"
[ "$hashed" -eq 1 ] || fail "a changed file must be the only read ($hashed)"

# ---- local mode: the store is authoritative, no commit is required
[ "$(store mode)" = local ] || fail "expected local mode"
[ "$(store authoritative)" = true ] || fail "local store must be authoritative"
[ "$(store commit_required)" = false ] || fail "commit must not be required"

# ---- distributed mode: status and state mark the store non-authoritative
mkdir -p .hyperfide
printf '{"schema_version":1,"mode":"distributed","authority_epoch":"10000000-0000-0000-0000-000000000001"}' \
    > .hyperfide/authority.json
chmod 600 .hyperfide/authority.json
[ "$(store mode)" = distributed ] || fail "expected distributed mode"
[ "$(store authoritative)" = false ] ||
    fail "distributed mode must mark the store non-authoritative"
has "$("$CG" status)" "distributed mode, NON-AUTHORITATIVE"
# state's spec section is refused in distributed mode (the authority owns
# it); its stderr refusal is expected and not part of this assertion
has "$("$CG" state 2>/dev/null)" "distributed mode, NON-AUTHORITATIVE"
"$CG" state --json 2>/dev/null | python3 -c '
import json, sys
s = json.load(sys.stdin)["codify_snapshot"]["store"]
assert s["mode"] == "distributed" and s["authoritative"] is False, s' ||
    fail "state --json must carry the non-authoritative store"

# offline under a distributed descriptor is still not the authority
out="$(HYPERFIDE_MODE=offline "$CG" status)"
has "$out" "offline mode, NON-AUTHORITATIVE"

# Negative: the gate opened for status and state only; a legacy write is
# still refused in distributed mode.
rc=0; out="$("$CG" spec claim 1 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "distributed mode must still refuse legacy writes"
has "$out" "DISTRIBUTED_COMMAND_UNSUPPORTED"

# and with the descriptor gone the store is the authority again
rm .hyperfide/authority.json
[ "$(store authoritative)" = true ] || fail "local mode must be authoritative"

echo "PASS: 89_vcs_statcache"
