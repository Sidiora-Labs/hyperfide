#!/usr/bin/env bash
# Qualification inputs are tracked on main (hyperfide-v21 req 1.1, D1) and
# every evidence commit stays reachable under refs/evidence/* (req 1.2, D10).
# A fresh clone or CI checkout must be able to run every verify_cmd in
# spec/hyperfide/spec.kvx without files that only exist on the main host.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"

# Expected counts: one manifest and one registration per hyperfide task with a
# task-component verify_cmd, plus the full-case registrations. Change these
# only together with the task list in spec/hyperfide/spec.kvx.
expect_manifests=125
expect_registrations=125
expect_full_registrations=2

fail=0
bad() { echo "FAIL $*"; fail=1; }

for dir in tests/hyperfide/manifests/tasks tests/hyperfide/registrations; do
    if git check-ignore -q "$dir/" || git check-ignore -q "$dir/x.json"; then
        bad "$dir is gitignored"
    fi
    untracked=$(git ls-files --others --exclude-standard -- "$dir" | wc -l)
    [ "$untracked" -eq 0 ] || bad "$dir has $untracked untracked file(s)"
done

count() { git ls-files -- "$1" | grep -c "$2" || true; }
n=$(count tests/hyperfide/manifests/tasks '^tests/hyperfide/manifests/tasks/[0-9][0-9.]*\.json$')
[ "$n" -eq "$expect_manifests" ] || bad "tracked task manifests: $n, expected $expect_manifests"
n=$(count tests/hyperfide/registrations '^tests/hyperfide/registrations/[0-9][0-9.]*\.json$')
[ "$n" -eq "$expect_registrations" ] || bad "tracked task registrations: $n, expected $expect_registrations"
n=$(count tests/hyperfide/registrations/full '^tests/hyperfide/registrations/full/V-[0-9]*\.json$')
[ "$n" -eq "$expect_full_registrations" ] || bad "tracked full registrations: $n, expected $expect_full_registrations"

# Every repo path a verify_cmd names must be tracked, not merely present.
paths=$(python3 -I - spec/hyperfide/spec.kvx <<'PY'
import re, sys
seen = set()
for line in open(sys.argv[1]):
    m = re.match(r'\s*verify_cmd\s*=\s*"(.*)"\s*$', line)
    if not m:
        continue
    for tok in re.findall(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+', m.group(1)):
        if tok not in seen:
            seen.add(tok)
            print(tok)
PY
)
named=0
while IFS= read -r p; do
    [ -n "$p" ] || continue
    named=$((named + 1))
    git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || bad "verify_cmd names untracked file $p"
done <<<"$paths"
[ "$named" -gt "$expect_manifests" ] || bad "only $named paths found in verify_cmds; parser out of step with spec.kvx"

# Evidence refs: the mapping is tracked; each ref must resolve to its commit.
map=tests/hyperfide/evidence-refs.json
git ls-files --error-unmatch -- "$map" >/dev/null 2>&1 || bad "$map is not tracked"
# The evidence indexes are gitignored local data; a task worktree reads them
# from the main worktree that shares this repository.
artifacts=${HYPERFIDE_ARTIFACTS:-}
if [ -z "$artifacts" ]; then
    common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
    for cand in "$repo/artifacts/hyperfide/tasks" "$(dirname "$common")/artifacts/hyperfide/tasks"; do
        if [ -d "$cand" ]; then artifacts=$cand; break; fi
    done
fi
python3 -I - "$map" "$artifacts" >"${TMPDIR:-/tmp}/evref.$$" <<'PY' || fail=1
import glob, json, os, re, sys
m = json.load(open(sys.argv[1]))
refs = m["refs"]
ok = True
names = [r["ref"] for r in refs]
if len(set(names)) != len(names):
    print("FAIL duplicate refs in mapping"); ok = False
for r in refs:
    if not re.fullmatch(r"refs/evidence/[0-9]+\.[0-9]+/[0-9]+", r["ref"]) or not re.fullmatch(r"[0-9a-f]{40}", r["commit"]):
        print(f"FAIL malformed mapping entry {r}"); ok = False
have = {(r["task"], r["commit"]) for r in refs}
art = sys.argv[2]
if art:
    for p in glob.glob(os.path.join(art, "*", "evidence-index.json")):
        d = json.load(open(p))
        for f in ("commit", "requalified_on"):
            c = d.get(f)
            if c and (d["task"], c) not in have:
                print(f"FAIL {p} {f}={c} has no refs/evidence entry"); ok = False
else:
    print("NOTE no local artifacts/hyperfide/tasks; mapping not cross-checked against evidence indexes")
for r in refs:
    print(f"REF {r['ref']} {r['commit']}")
sys.exit(0 if ok else 1)
PY
grep -v '^REF ' "${TMPDIR:-/tmp}/evref.$$" || true
present=$(git for-each-ref --format=x refs/evidence | wc -l)
if [ "$present" -eq 0 ]; then
    # D12: the refs are published on origin and CI fetches them, so a checkout
    # without them is a broken checkout, not a legitimate skip.
    bad "no refs/evidence in this checkout (git fetch origin 'refs/evidence/*:refs/evidence/*')"
else
    total=0
    while read -r tag ref commit; do
        [ "$tag" = REF ] || continue
        total=$((total + 1))
        got=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null || true)
        [ "$got" = "$commit" ] || bad "$ref resolves to '${got:-nothing}', expected $commit"
    done <"${TMPDIR:-/tmp}/evref.$$"
    echo "evidence refs checked: $total"
fi
rm -f "${TMPDIR:-/tmp}/evref.$$"

[ "$fail" -eq 0 ] || exit 1
echo "PASS qualification inputs tracked; evidence refs reachable"
