#!/usr/bin/env bash
# sparse worktrees for the local fleet (hyperfide-v21 2.13, req 6.1): a
# fleet worker's tree holds only its task's slice — the manifest paths, the
# build roots on their directories and the feature's spec — cut with git
# worktree add plus a no-cone sparse-checkout from the same manifest
# `hyperfide slice` prints. A task the slice cannot state, or a worker told
# --full-tree, gets the whole tree with the reason recorded, never silently.
# Since 3.20 sparse is the default ([hierarchy] sparse = "full" opts out) and
# `slice <id> --widen PATH --reason CODE` is the recorded way out of a slice.
. "$(dirname "$0")/../lib.sh"

pyjson() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# the files a worktree holds on disk, repository-relative, sorted
tree_files() {
    (cd "$1" && find . -path ./.git -prune -o -type f -print | sed 's#^\./##' | LC_ALL=C sort)
}

mkdir -p "$TMP/proj/src/deep" "$TMP/proj/lib/sub" "$TMP/proj/docs"
cd "$TMP/proj"
git init -q -b main . 2>/dev/null || git init -q .
git config user.email t@t; git config user.name t
echo 'export const a = 1;' > src/a.ts
echo 'export const b = 2;' > src/b.ts
echo 'export const c = 3;' > src/deep/c.ts
echo 'module x' > src/go.mod
echo 'export const l = 4;' > lib/b.ts
echo '{}' > lib/sub/package.json
echo 'all:' > lib/Makefile
echo '# doc' > docs/d.md
echo 'all:' > Makefile
echo '{"name":"p"}' > package.json
"$CG" spec new wt >/dev/null
"$CG" spec docs off >/dev/null
"$CG" spec start 1.1 >/dev/null
"$CG" spec done 1.1 >/dev/null
"$CG" spec mode parallel >/dev/null
"$CG" spec add 2.1 --title "Alpha" --wave 1 --reqs 1.1 --touches 'src/a.ts,src/deep' >/dev/null
"$CG" spec add 2.2 --title "No touches" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 2.3 --title "Glob" --wave 1 --reqs 1.1 --touches 'lib/*.ts' >/dev/null
"$CG" spec add 2.4 --title "Docs" --wave 1 --reqs 1.1 --touches 'docs/d.md' >/dev/null
"$CG" spec add 2.5 --title "Refactor" --wave 1 --reqs 1.1 --touches 'src/b.ts' >/dev/null
"$CG" spec add 2.6 --title "Service" --wave 1 --reqs 1.1 --touches 'lib/b.ts' >/dev/null
"$CG" spec add 2.7 --title "Default" --wave 1 --reqs 1.1 --touches 'lib/sub/package.json' >/dev/null
"$CG" init >/dev/null
printf '.codegraph/\n*.lock\n' > .gitignore
cat >> spec/workflow.kvx <<'EOF'

[hierarchy]
test_gate = "true"
pr        = "manual"
EOF
git add -A >/dev/null; git commit -qm base >/dev/null
spec_files="$(git ls-files spec/wt spec/workflow.kvx | LC_ALL=C sort)"

# ---- the slice manifest from the task packet
out="$("$CG" slice 2.1 --json)"
echo "$out" | pyjson '
assert d["kind"] == "hyperfide.workspace-slice" and d["schema_version"] == 1, d
assert d["mode"] == "SLICE" and d["fallback_reason"] is None and d["source"] == "PACKET", d
assert d["included_paths"] == ["src/a.ts", "src/deep/"], d["included_paths"]
assert d["build_roots"] == ["Makefile", "package.json", "src/go.mod"], d["build_roots"]
assert d["metadata_roots"] == ["spec/workflow.kvx", "spec/wt/"], d["metadata_roots"]
assert d["digest"].startswith("sha256:") and len(d["digest"]) == 71, d["digest"]
assert len(d["commit"]) == 40, d["commit"]' || fail "slice 2.1 manifest"
digest="$(echo "$out" | pyjson 'print(d["digest"])')"
[ -f .codegraph/slices/wt/2.1.json ] || fail "manifest not stored"
again="$("$CG" slice 2.1 --json | pyjson 'print(d["digest"])')"
[ "$again" = "$digest" ] || fail "the derived digest is not stable"
txt="$("$CG" slice 2.1)"
has "$txt" "SLICE from the task packet"
has "$txt" "path   src/deep/"
has "$txt" "build  src/go.mod"

# ---- the worker tree holds exactly the manifest paths and build roots
out="$("$CG" fleet begin 2.1 --sparse --json)"
wt="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "
w = d['workspace']
assert w['mode'] == 'SLICE' and w['fallback_reason'] is None, w
assert w['slice_digest'] == '$digest', w
assert w['paths'] == 7, w" || fail "begin --sparse workspace"
want="$(printf '%s\n' Makefile package.json src/a.ts src/deep/c.ts src/go.mod $spec_files | LC_ALL=C sort)"
got="$(tree_files "$wt")"
[ "$got" = "$want" ] || fail "sparse tree differs from the manifest:
got:
$got
want:
$want"
for absent in src/b.ts lib/b.ts lib/Makefile lib/sub/package.json docs/d.md .gitignore; do
    [ ! -e "$wt/$absent" ] || fail "$absent is outside the slice but checked out"
done
[ -z "$(git -C "$wt" status --porcelain)" ] || fail "a fresh sparse tree is not clean"
# the main tree stays full and is not itself sparse
[ -f lib/b.ts ] && [ -f docs/d.md ] || fail "the main tree lost files"
[ "$(git config --get core.sparseCheckout || true)" != "true" ] || fail "main tree became sparse"
# the commit graph is whole: out-of-slice files stay in the branch tree
git -C "$wt" ls-tree -r --name-only HEAD | grep -qx 'lib/b.ts' || fail "branch tree lost lib/b.ts"

# ---- negative: a write outside the slice is refused, one inside commits
echo 'x' > "$wt/src/b.ts"
if git -C "$wt" add src/b.ts 2>/dev/null; then fail "git add outside the slice was accepted"; fi
rm -f "$wt/src/b.ts"
echo 'export const a = 10;' > "$wt/src/a.ts"
git -C "$wt" add src/a.ts
git -C "$wt" commit -qm "alpha"
changed="$(git -C "$wt" show --name-only --format= HEAD)"
[ "$changed" = "src/a.ts" ] || fail "a sparse commit changed more than its file: $changed"
git -C "$wt" ls-tree -r --name-only HEAD | grep -qx 'docs/d.md' || fail "sparse commit dropped docs/d.md"

# ---- begin is idempotent: a reused tree is reported, not re-cut
out="$("$CG" fleet begin 2.1 --sparse --json)"
echo "$out" | pyjson "assert d['workspace']['mode'] == 'REUSED' and not d['worktree_created'], d" \
    || fail "reused worktree"

# ---- FULL_TREE with a recorded reason: no touches, and a glob
"$CG" slice 2.2 --json | pyjson '
assert d["mode"] == "FULL_TREE" and d["fallback_reason"] == "TASK_HAS_NO_TOUCHES", d
assert d["included_paths"] == [] and d["build_roots"] == [], d' || fail "no-touches fallback"
"$CG" slice 2.3 --json | pyjson '
assert d["mode"] == "FULL_TREE" and d["fallback_reason"] == "OWNED_SCOPE_PATTERN_UNSUPPORTED", d' \
    || fail "glob fallback"
out="$("$CG" fleet begin 2.2 --sparse --json)"
wt2="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "
w = d['workspace']
assert w['mode'] == 'FULL_TREE' and w['fallback_reason'] == 'TASK_HAS_NO_TOUCHES' and w['slice_digest'] is None, w" \
    || fail "fallback begin"
[ -f "$wt2/lib/b.ts" ] && [ -f "$wt2/src/b.ts" ] || fail "fallback tree is not full"

# ---- sparse is the default (3.20): no flag and no [hierarchy] key cuts a slice
out="$("$CG" fleet begin 2.7 --json)"
wt7="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "
w = d['workspace']
assert w['mode'] == 'SLICE' and w['fallback_reason'] is None and w['slice_digest'].startswith('sha256:'), w" \
    || fail "a default fleet worker is not sparse"
[ -f "$wt7/lib/sub/package.json" ] || fail "default slice lost its touch"
[ ! -e "$wt7/src/a.ts" ] && [ ! -e "$wt7/lib/b.ts" ] || fail "default slice holds paths outside it"
[ "$(git -C "$wt7" config --get core.sparseCheckout)" = "true" ] || fail "default worker tree is not sparse"
# [hierarchy] sparse = "full" opts the fleet out, and the opt-out is the reason
echo 'sparse    = "full"' >> spec/workflow.kvx
out="$("$CG" fleet begin 2.4 --json)"
wt4="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "
w = d['workspace']
assert w['mode'] == 'FULL_TREE' and w['fallback_reason'] == 'HIERARCHY_SPARSE_FULL' and w['slice_digest'] is None, w" \
    || fail "sparse = full did not record its reason"
[ -f "$wt4/lib/b.ts" ] && [ -f "$wt4/src/b.ts" ] || fail "sparse = full tree is not full"

# ---- the local widen step: the path joins the checkout and the task packet
wspec="$wt/spec/wt/spec.kvx"
[ -f "$wspec" ] || fail "the worker holds no spec at $wspec"
if "$CG" slice 2.1 --widen lib/b.ts >/dev/null 2>&1; then fail "a widen without --reason was accepted"; fi
if "$CG" slice 2.1 --widen lib/b.ts --reason "why" >/dev/null 2>&1; then fail "a widen reason that is not a code was accepted"; fi
if "$CG" slice 2.1 --widen ../x --reason OUT_OF_SLICE_WRITE >/dev/null 2>&1; then fail "a widen outside the repository was accepted"; fi
if "$CG" slice 2.1 --widen 'lib/*.ts' --reason OUT_OF_SLICE_WRITE >/dev/null 2>&1; then fail "a widen glob was accepted"; fi
if "$CG" slice 2.1 --widen src/deep/c.ts --reason OUT_OF_SLICE_WRITE >/dev/null 2>&1; then
    fail "a widen of a path already in the slice was accepted"
fi
if "$CG" slice 2.4 --widen lib/b.ts --reason OUT_OF_SLICE_WRITE >/dev/null 2>&1; then
    fail "a widen of a full-tree worker was accepted"
fi
out="$("$CG" slice 2.1 --widen lib/b.ts --widen docs/ --reason OUT_OF_SLICE_WRITE --json)"
echo "$out" | pyjson "
assert d['task'] == '2.1' and d['reason'] == 'OUT_OF_SLICE_WRITE', d
assert d['added_paths'] == ['lib/b.ts', 'docs/'], d['added_paths']
assert d['parent_slice_digest'] == '$digest' and d['slice_digest'] != '$digest', d
assert d['recorded_in'] == '$wspec', d" || fail "widen result"
python3 - "$wspec" <<'PY' || fail "the widen is not recorded in the worker's task packet"
import re, sys
t = open(sys.argv[1]).read()
blk = t[t.index("[task.2.1]"):]
blk = blk[:blk.find("\n[", 1)] if "\n[" in blk[1:] else blk
assert re.search(r'touches\s*=\s*\["src/a.ts", "src/deep", "lib/b.ts", "docs/"\]', blk), blk
assert re.search(r'widened\s*=\s*\["OUT_OF_SLICE_WRITE:lib/b.ts", "OUT_OF_SLICE_WRITE:docs/"\]', blk), blk
PY
[ -f "$wt/lib/b.ts" ] && [ -f "$wt/docs/d.md" ] || fail "widened paths are not checked out"
[ ! -e "$wt/src/b.ts" ] || fail "the widen checked out more than it named"
git -C "$wt" sparse-checkout list | grep -qx '/lib/b.ts' || fail "sparse patterns lack the widened path"
echo 'export const l = 40;' > "$wt/lib/b.ts"
git -C "$wt" add lib/b.ts spec/wt/spec.kvx || fail "git add of a widened path was refused"
git -C "$wt" commit -qm "widened"
"$CG" events --kind fleet.widen --json -n 5 | python3 -c '
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
pay = lambda r: r["payload"] if isinstance(r.get("payload"), dict) else json.loads(r.get("payload") or "{}")
p = [pay(r) for r in rows if pay(r).get("task") == "2.1"]
assert p and p[0]["reason"] == "OUT_OF_SLICE_WRITE" and p[0]["added_paths"] == ["lib/b.ts", "docs/"], p' \
    || fail "no fleet.widen event"

# ---- --full-tree records its reason, and refuses one that is not a code
if "$CG" fleet begin 2.5 --full-tree "because" >/dev/null 2>&1; then
    fail "--full-tree accepted a reason that is not a code"
fi
out="$("$CG" fleet begin 2.5 --full-tree WHOLE_REPO_REFACTOR --json)"
wt5="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "
w = d['workspace']
assert w['mode'] == 'FULL_TREE' and w['fallback_reason'] == 'WHOLE_REPO_REFACTOR', w" || fail "--full-tree"
[ -f "$wt5/lib/b.ts" ] || fail "--full-tree tree is not full"
"$CG" events --kind fleet.begin --json -n 50 | python3 -c '
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
pay = lambda r: r["payload"] if isinstance(r.get("payload"), dict) else json.loads(r.get("payload") or "{}")
seen = {pay(r).get("task"): pay(r) for r in rows}
assert seen["2.5"]["workspace"] == "FULL_TREE" and seen["2.5"]["fallback_reason"] == "WHOLE_REPO_REFACTOR", seen["2.5"]
assert seen["2.7"]["workspace"] == "SLICE" and seen["2.7"]["slice_digest"].startswith("sha256:"), seen["2.7"]
assert seen["2.4"]["workspace"] == "FULL_TREE" and seen["2.4"]["fallback_reason"] == "HIERARCHY_SPARSE_FULL", seen["2.4"]' \
    || fail "fleet.begin events do not record the workspace"

# ---- a service manifest (the routed `slice inspect` result) wins
hex="$(printf 'service' | sha256sum | cut -d' ' -f1)"
cat > "$TMP/svc.json" <<EOF
{"protocol_version":1,"ok":true,"result":{"digest":"sha256:$hex","manifest":{"schema_version":1,"kind":"hyperfide.workspace-slice","mode":"SLICE","fallback_reason":null,"included_paths":["lib/b.ts"],"build_roots":["lib/Makefile"],"metadata_roots":[],"digest":"sha256:$hex"}}}
EOF
"$CG" slice 2.6 --manifest "$TMP/svc.json" --json | pyjson "
assert d['source'] == 'SERVICE' and d['digest'] == 'sha256:$hex', d
assert d['included_paths'] == ['lib/b.ts'] and d['build_roots'] == ['lib/Makefile'], d" || fail "service manifest"
out="$("$CG" fleet begin 2.6 --sparse --json)"
wt6="$(echo "$out" | pyjson 'print(d["worktree"])')"
echo "$out" | pyjson "assert d['workspace']['slice_digest'] == 'sha256:$hex', d['workspace']" \
    || fail "begin did not use the stored service manifest"
[ "$(tree_files "$wt6")" = "$(printf '%s\n' lib/Makefile lib/b.ts)" ] \
    || fail "service-sliced tree differs: $(tree_files "$wt6")"

# ---- negative manifests are refused, by reason
bad() {   # bad <label> <python edit of manifest m>
    python3 - "$TMP/svc.json" "$TMP/bad.json" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); m = d["result"]["manifest"]
exec(sys.argv[3])
json.dump(d, open(sys.argv[2], "w"))
PY
    if "$CG" slice 2.6 --manifest "$TMP/bad.json" >/dev/null 2>"$TMP/err"; then
        fail "$1 manifest was accepted"
    fi
}
bad "escaping path"     'm["included_paths"] = ["../etc/passwd"]'
bad "git metadata"      'm["included_paths"] = [".git/config"]'
bad "SLICE with reason" 'm["fallback_reason"] = "WHY_NOT"'
bad "reasonless full"   'm["mode"] = "FULL_TREE"'
bad "wrong kind"        'm["kind"] = "hyperfide.other"'
bad "no digest"         'del m["digest"]'
has "$(cat "$TMP/err")" "carries no sha256 digest"
"$CG" slice 9.9 >/dev/null 2>&1 && fail "slice of an unknown task succeeded"

echo "85_sparse_worktree: ok"
