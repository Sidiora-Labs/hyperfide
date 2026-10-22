#!/usr/bin/env bash
# superseded under the fleet (hyperfide-v21 3.11, req 2.3): a feature that
# carries a superseded task (2.15, a closed terminal status) runs under
# `cg fleet up`. The fleet never begins, spawns or waits on the superseded
# task, counts it closed in the tree, lands the wave, and the docs and drift
# paths treat it as closed too. Negative: the same feature with the task
# still pending is not complete until that task runs.
. "$(dirname "$0")/../lib.sh"

pyjson() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# Feature sf: 2.1 is superseded by 2.2; both sit in wave 1. Superseded, 2.1
# declares 2.2's file, so drift would predict a collision if it were open.
setup_repo() {
    local old_touches='src/c.ts'
    [ "$1" = superseded ] && old_touches='src/a.ts'
    rm -rf "$TMP/proj" "$TMP/go"
    mkdir -p "$TMP/proj/src" "$TMP/go"
    cd "$TMP/proj"
    git init -q -b main . 2>/dev/null || git init -q .
    git config user.email t@t; git config user.name t
    printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
    printf 'export function gamma(): number {\n  return 1;\n}\n' > src/c.ts
    "$CG" spec new sf >/dev/null
    "$CG" spec docs off >/dev/null
    "$CG" spec start 1.1 >/dev/null
    "$CG" spec done 1.1 >/dev/null
    "$CG" spec mode parallel >/dev/null
    "$CG" spec add 2.1 --title "Old alpha" --wave 1 --reqs 1.1 --symbols gamma --touches "$old_touches" >/dev/null
    "$CG" spec add 2.2 --title "Alpha" --wave 1 --reqs 1.1 --symbols alpha --touches 'src/a.ts' >/dev/null
    if [ "$1" = superseded ]; then
        python3 - spec/sf/spec.kvx <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
head, sep, rest = s.partition('[task.2.1]\n')
body, nxt, tail = rest.partition('\n[')
body = re.sub(r'^status = "[^"]*"$', 'status = "superseded"', body, flags=re.M)
body += '\nsuperseded_by = "2.2"\nsuperseded_reason = "2.2 carries this work"'
open(p, 'w').write(head + sep + body + nxt + tail)
EOF
    fi
    "$CG" init >/dev/null
    printf '.codegraph/\n*.lock\n' > .gitignore
    cat >> spec/workflow.kvx <<EOF

[hierarchy]
test_gate = "true"
pr        = "manual"

[role.worker]
retries = 0

[agents]
driver = "custom"
cmd    = "sh $TMP/driver.sh \${PROMPT_FILE} \${TASK} \${ROOT} \${AGENT}"
max    = 1
ttl    = 600
EOF
    cat > "$TMP/driver.sh" <<EOF
#!/bin/sh
PF="\$1"; TASK="\$2"; ROOT="\$3"; AGENT="\$4"
cd "\$ROOT" || exit 9
if [ "\$CG_ROLE" = worker ]; then
    : > "$TMP/go/spawned-\$TASK"
    "$CG" spec start "\$TASK" >/dev/null 2>&1
    case "\$TASK" in
        2.1) printf 'export function gamma(): number {\n  return 5;\n}\n' > src/c.ts ;;
        *)   printf 'export function alpha(): number {\n  return 7;\n}\n' > src/a.ts ;;
    esac
    "$CG" spec done "\$TASK" >/dev/null 2>&1
    git add -A >/dev/null
    git commit -qm "\$TASK [spec:\$CG_FEATURE/\$TASK]" >/dev/null || exit 1
    exec "$CG" fleet merge-up "\$TASK" >/dev/null
fi
left="\$("$CG" fleet tree -f "\$CG_FEATURE" --json | python3 -c 'import json,os,sys; w = os.environ.get("CG_WAVE"); m = [m for m in json.load(sys.stdin)["managers"] if w is None or m["wave"] == int(w)][0]; print(m["tasks"]["total"] - m["tasks"]["done"])')"
echo "\$left" > "$TMP/go/left"
[ "\$left" -eq 0 ] || exit 0
exec "$CG" fleet land \${CG_WAVE:-} -f "\$CG_FEATURE" --no-pr >/dev/null 2>"$TMP/go/land.err"
EOF
    git add -A >/dev/null; git commit -qm base >/dev/null
}

# ---- positive: the superseded task is closed for the whole fleet path
setup_repo superseded
"$CG" spec lint -f sf >/dev/null 2>&1 || fail "the fixture spec does not lint: $("$CG" spec lint -f sf 2>&1)"
dry="$("$CG" fleet up --dry-run -n 1 2>&1)" || fail "dry run: $dry"
hasnt "$dry" "— 2.1 (wave"
collide="$("$CG" drift collisions -f sf --json)" || fail "drift collisions: $collide"
printf '%s' "$collide" | pyjson 'assert d["collisions"] == [], d' \
    || fail "drift still counts the superseded task open: $collide"
rc=0; out="$(timeout 180 "$CG" fleet up --foreground -n 1 2>&1)" || rc=$?
hasnt "$out" "was refused"
hasnt "$out" "max-fail"
[ "$rc" -eq 0 ] || fail "a feature with a superseded task should run to completion, rc $rc: $out"
[ ! -f "$TMP/go/spawned-2.1" ] || fail "the superseded task was spawned: $out"
[ -f "$TMP/go/spawned-2.2" ] || fail "the live task never ran: $out"
has "$out" "[fleet] sf complete"
grep -q '^status = "superseded"' <(sed -n '/^\[task.2.1\]/,/^\[/p' spec/sf/spec.kvx) \
    || fail "2.1 lost its superseded status: $(sed -n '/^\[task.2.1\]/,/^\[/p' spec/sf/spec.kvx)"
"$CG" fleet tree -f sf --json | pyjson '
m = d["managers"][0]
assert m["tasks"]["total"] == m["tasks"]["done"], m["tasks"]
' || fail "the fleet tree still counts the superseded task open: $("$CG" fleet tree -f sf --json)"
# every live task qualified: documentation no longer waits on 2.1
"$CG" spec docs auto >/dev/null
docs="$("$CG" docs status -f sf 2>&1)" || fail "docs status: $docs"
hasnt "$docs" "waiting"
[ "$(git show main:src/c.ts | grep -c 'return 1')" = 1 ] || fail "superseded work reached main"
[ "$(git show main:src/a.ts | grep -c 'return 7')" = 1 ] || fail "the live task did not land on main"

# ---- negative: the same task left pending is real work the fleet must run
setup_repo pending
rc=0; out="$(timeout 180 "$CG" fleet up --foreground -n 1 2>&1)" || rc=$?
hasnt "$out" "was refused"
[ "$rc" -eq 0 ] || fail "two live tasks should both run, rc $rc: $out"
[ -f "$TMP/go/spawned-2.1" ] || fail "a pending task was skipped as if closed: $out"
[ "$(git show main:src/c.ts | grep -c 'return 5')" = 1 ] || fail "the pending task did not land"

echo "superseded fleet OK"
