#!/usr/bin/env bash
# 7.6: the owner's full-system test. spec/hyperfide-v22/evidence/human-gate.json
# records the run (date, commit, task, sandbox id, verdict); the commit is
# reachable from HEAD, the verdict is pass, and the record is newer than the
# release commit (the latest commit tagged [spec:hyperfide-v22/7.4]).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
fail() { echo "FAIL $*" >&2; exit 1; }
gate=spec/hyperfide-v22/evidence/human-gate.json
[ -f "$gate" ] || fail "$gate is missing"

release=$(git log -1 --format=%H --grep='\[spec:hyperfide-v22/7\.4\]' HEAD)
[ -n "$release" ] || fail "no release commit tagged [spec:hyperfide-v22/7.4] reachable from HEAD"
release_at=$(git log -1 --format=%ct "$release")

python3 -I - "$gate" "$release_at" <<'PY'
import json, sys
from datetime import datetime, timezone
gate, release_at = sys.argv[1], int(sys.argv[2])
try:
    rec = json.load(open(gate))
except ValueError as e:
    sys.exit(f"FAIL {gate} is not JSON: {e}")
missing = [k for k in ("date", "commit", "task", "sandbox_id", "verdict") if not str(rec.get(k, "")).strip()]
if missing:
    sys.exit(f"FAIL {gate} lacks: {', '.join(missing)}")
if rec["verdict"] != "pass":
    sys.exit(f"FAIL verdict is {rec['verdict']!r}, expected 'pass'")
try:
    when = datetime.fromisoformat(str(rec["date"]).replace("Z", "+00:00"))
except ValueError as e:
    sys.exit(f"FAIL date {rec['date']!r} is not ISO 8601: {e}")
if when.tzinfo is None:
    when = when.replace(tzinfo=timezone.utc)
if when.timestamp() < release_at:
    sys.exit(f"FAIL run dated {rec['date']} precedes the release commit")
print(f"human gate: {rec['task']} in sandbox {rec['sandbox_id']} on {rec['date']} -> {rec['verdict']}")
PY

commit=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$gate")
git cat-file -e "$commit^{commit}" 2>/dev/null || fail "commit $commit is not in this repository"
git merge-base --is-ancestor "$commit" HEAD || fail "commit $commit is not reachable from HEAD"
echo "human gate: commit $(git rev-parse --short "$commit") reachable; release commit $(git rev-parse --short "$release")"
