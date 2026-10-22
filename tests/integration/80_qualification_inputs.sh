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

# Tracked receipts (tests/hyperfide/evidence-receipts, or HYPERFIDE_EVIDENCE_RECEIPTS_DIR)
# carry the bundle's evidence-index commits; each must have a refs/evidence entry for
# its task. This needs no store and no artifacts/, so a fresh clone and CI run it. A
# generated fixture pair (one mapped, one unmapped commit) proves the check passes
# and bites even before any receipt is published.
python3 -I - "$map" "$repo/tests/hyperfide" <<'PY' || fail=1
import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import evidence_store as es
refs = json.load(open(sys.argv[1]))["refs"]
have = {(r["task"], r["commit"]) for r in refs}

def cross_check(directory):
    problems, seen = [], 0
    for path in sorted(Path(directory).glob("*.json")):
        seen += 1
        task = path.stem
        try:
            record = es.validate_record(json.loads(path.read_text()), task)
        except (ValueError, es.EvidenceIntegrityError) as exc:
            problems.append(f"{path} is not a valid receipt record: {exc}"); continue
        commits = record.get("evidence_commits")
        if not commits:
            problems.append(f"{path} names no evidence commit to map"); continue
        for field, commit in sorted(commits.items()):
            if (task, commit) not in have:
                problems.append(f"{path} {field}={commit} has no refs/evidence entry")
    return seen, problems

def fixture(directory, task, commit):
    org, run, artifact = "7d0f9a52-6c0e-4b8e-9a51-3f1c2d4e5a60", "1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8", "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f"
    digest = "sha256:" + "ab" * 32
    receipt = {"schema_version": 1, "organisation_id": org, "run_id": run, "artifact_id": artifact, "digest": digest, "size_bytes": "512",
               "storage_backend": "s3-v1", "storage_key": es.key_of(org, run, digest, True), "completed_at": "2026-10-22T00:00:00.000Z"}
    receipt["receipt_id"] = es.receipt_id(receipt)
    record = {"schema_version": 1, "kind": es.RECORD_KIND, "task": task, "bundle_format": "tar", "content_digest": "sha256:" + "cd" * 32,
              "total_size_bytes": "10240", "chunk_count": 1, "retention_class": "RELEASE", "receipt": receipt, "evidence_commits": {"commit": commit, "requalified_on": commit}}
    (Path(directory) / (task + ".json")).write_text(json.dumps(record))

os.environ.pop("HF_ARTIFACT_ORGANISATION_ID", None)
ok = True
with tempfile.TemporaryDirectory() as good, tempfile.TemporaryDirectory() as bad:
    fixture(good, refs[0]["task"], refs[0]["commit"])
    fixture(bad, refs[0]["task"], "0" * 40)
    if cross_check(good) != (1, []):
        print("FAIL receipt cross-check rejects a mapped fixture receipt:", cross_check(good)[1]); ok = False
    if not cross_check(bad)[1]:
        print("FAIL receipt cross-check accepts an unmapped fixture commit"); ok = False
directory = es.receipts_dir(Path(sys.argv[2]).parents[1])
if directory.is_dir():
    seen, problems = cross_check(directory)
    for problem in problems:
        print("FAIL " + problem); ok = False
    print(f"evidence receipts cross-checked: {seen} in {directory}")
else:
    print(f"NOTE no tracked receipts at {directory}; fixture cross-check only")
sys.exit(0 if ok else 1)
PY
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
