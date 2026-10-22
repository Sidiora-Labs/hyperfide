#!/usr/bin/env bash
# Asks in the C core (hyperfide-v21 3.4, req 3.3): cg ask raise, answer,
# list and expire over the asks table; each of the five kinds; the default
# policy per kind (D11: secret, variable, permission block; decision and
# question proceed on the recommended option and are flagged) and its
# override from [asks] in the workflow; expiry under both policies, the
# proceed default recorded as a decision memory naming the Ask; the
# ask.raised, ask.answered and ask.expired events; the serve snapshot's asks
# array; and fleet approvals as the permission kind, decided from either
# side.
. "$(dirname "$0")/../lib.sh"

pyjson() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
ev() { "$CG" events --kind "$1" --json -n 500; }
raise_id() { "$CG" ask raise "$@" --json | pyjson 'print(d["id"])'; }
ask_field() {   # ask_field <id> <python expr over a>
    "$CG" ask list --all --json |
        python3 -c "import json,sys
a=[x for x in json.load(sys.stdin)['asks'] if x['id']==$1][0]
print($2)"
}

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
git init -q . 2>/dev/null
git config user.email t@t; git config user.name t
"$CG" init >/dev/null 2>&1
"$CG" spec new demo >/dev/null
"$CG" spec add 2.1 --title "Alpha" --wave 1 --reqs 1.1 >/dev/null
cat >> spec/workflow.kvx <<'EOF'

[hierarchy]
enabled = true

[role.main]
approve = ["pr"]
EOF
git add -A >/dev/null
git commit -qm init
git branch wave/demo/1

# ---- nothing open yet; the snapshot carries an empty asks array
has "$("$CG" ask list)" "no open Asks"
snap() {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"snapshot"}' |
        "$CG" serve | head -1
}
snap | pyjson 'assert d["result"]["asks"] == [], d'

# ---- refusals: a bad kind, a missing title, a recommendation outside the
#      options, a proceed kind without a recommendation, a bad deadline
expect_rc 1 "$CG" ask raise opinion "What colour?"
expect_rc 1 "$CG" ask raise variable
expect_rc 1 "$CG" ask raise decision "Which store?" --option a --option b --recommend c
expect_rc 1 "$CG" ask raise decision "Which store?" --option a --option b
expect_rc 1 "$CG" ask raise question "Proceed?" --recommend yes --deadline soon
[ "$("$CG" ask list --all --json | pyjson 'print(len(d["asks"]))')" = 0 ] ||
    fail "a refused raise left a row"

# ---- raise each kind
past=@1000
sec=$(raise_id secret "Railway token for the live case" --deadline 1h \
      --chain operator,owner --task demo/2.1 --attempt att-1 --session s-1 \
      --sandbox sb-1)
var=$(raise_id variable "HF_SLICE_SOURCE_CONFIG path" --deadline "$past" --task demo/2.1)
perm=$(raise_id permission "Delete the orphan sandbox" --task demo/2.1)
dec=$(raise_id decision "Which object store?" --option s3 --option r2 \
      --recommend r2 --deadline "$past" --task demo/2.1 --body "both work")
que=$(raise_id question "Keep the old route?" --option yes --option no \
      --recommend yes --deadline 2h)

# the shape: policy per kind, options, chain, references
[ "$(ask_field "$sec" 'a["default_policy"], a["blocking"], a["chain"], a["task"], a["attempt"], a["session"], a["sandbox"], a["state"]')" = \
  "block True ['operator', 'owner'] demo/2.1 att-1 s-1 sb-1 open" ] || fail "secret shape: $(ask_field "$sec" 'a')"
[ "$(ask_field "$var" 'a["default_policy"]')" = block ] || fail "variable policy"
[ "$(ask_field "$perm" 'a["default_policy"], a["options"]')" = "block ['approve', 'reject']" ] ||
    fail "permission defaults: $(ask_field "$perm" 'a')"
[ "$(ask_field "$dec" 'a["default_policy"], a["blocking"], a["recommended"], a["options"], a["body"]')" = \
  "proceed-and-flag False r2 ['s3', 'r2'] both work" ] || fail "decision shape: $(ask_field "$dec" 'a')"
[ "$(ask_field "$que" 'a["default_policy"]')" = proceed-and-flag ] || fail "question policy"

# raised events, one per Ask, carrying the row
[ "$(ev ask.raised | python3 -c 'import json,sys; print(sorted(json.loads(l)["payload"]["kind"] for l in sys.stdin if l.strip()))')" = \
  "['decision', 'permission', 'question', 'secret', 'variable']" ] || fail "ask.raised events"
ev ask.raised | python3 -c "import json,sys
e=[json.loads(l) for l in sys.stdin if l.strip()]
s=[x for x in e if x['payload']['id']==$sec][0]
assert s['subject']=='ask/$sec' and s['payload']['state']=='open', s" || fail "ask.raised payload"

# the snapshot carries all five open Asks, overdue ones marked
snap | python3 -c "import json,sys
d=json.load(sys.stdin)['result']
ids={a['id']:a for a in d['asks']}
assert sorted(ids)==sorted([$sec,$var,$perm,$dec,$que]), ids
assert ids[$var]['overdue'] and ids[$dec]['overdue'] and not ids[$sec]['overdue'], ids
assert 'head' in d and 'native' in d, d" || fail "snapshot asks"

# ---- expiry under each default policy
out="$("$CG" ask expire)"
has "$out" "2 Asks passed their deadline"
# block: expired, still blocking, still answerable
[ "$(ask_field "$var" 'a["state"], a["blocking"], a["answer"]')" = "expired True None" ] ||
    fail "blocking expiry: $(ask_field "$var" 'a')"
# proceed-and-flag: answered with the recommendation, flagged, a decision
[ "$(ask_field "$dec" 'a["state"], a["answer"], a["answered_by"], a["decided_by_default"], a["decision"] is not None')" = \
  "answered r2 default True True" ] || fail "proceed expiry: $(ask_field "$dec" 'a')"
mid="$(ask_field "$dec" 'a["decision"]')"
has "$("$CG" recall --type decision --json)" "Ask #$dec (decision)"
has "$("$CG" recall --type decision --json)" "\"id\":$mid"
[ "$(ev ask.expired | python3 -c 'import json,sys; print(sorted((json.loads(l)["payload"]["kind"], json.loads(l)["payload"]["state"]) for l in sys.stdin if l.strip()))')" = \
  "[('decision', 'answered'), ('variable', 'expired')]" ] || fail "ask.expired events"
# a second sweep finds nothing; list shows the expired one, not the default
has "$("$CG" ask expire)" "0 Asks passed"
out="$("$CG" ask list)"
has "$out" "#$var"
has "$out" "expired"
hasnt "$out" "#$dec "
has "$("$CG" ask list --all)" "-> r2 (by default)"

# ---- answering: options enforced, secrets only by reference, once only
expect_rc 1 "$CG" ask answer "$que" maybe
expect_rc 1 "$CG" ask answer "$sec" hunter2
expect_rc 1 "$CG" ask answer 9999 yes
out="$("$CG" ask answer "$sec" secret-ref:railway-1 -m "in the vault")"
has "$out" "answered Ask #$sec"
hasnt "$(ev ask.answered)" "hunter2"
"$CG" ask answer "$var" /etc/hf/slices.json >/dev/null
"$CG" ask answer "$que" no >/dev/null
expect_rc 1 "$CG" ask answer "$que" yes
expect_rc 1 "$CG" ask answer "$dec" s3
[ "$(ask_field "$que" 'a["state"], a["answer"], a["decided_by_default"], a["state_version"]')" = "answered no False 2" ] ||
    fail "question answer: $(ask_field "$que" 'a')"
[ "$(ask_field "$sec" 'a["answer"], a["note"]')" = "secret-ref:railway-1 in the vault" ] || fail "secret answer"
[ "$(ev ask.answered | python3 -c 'import json,sys; print(sorted(json.loads(l)["payload"]["id"] for l in sys.stdin if l.strip()))')" = \
  "$(python3 -c "print(sorted([$sec,$var,$que]))")" ] || fail "ask.answered events"
# answered Asks leave the snapshot; the open permission stays
snap | pyjson "assert [a['id'] for a in d['result']['asks']] == [$perm], d" || fail "snapshot after answers"
"$CG" ask answer "$perm" reject >/dev/null

# ---- [asks] in the workflow overrides a kind's policy
printf '\n[asks]\nquestion = "block"\n' >> spec/workflow.kvx
q2=$(raise_id question "Which name?")
[ "$(ask_field "$q2" 'a["default_policy"], a["blocking"]')" = "block True" ] || fail "[asks] override"
"$CG" ask answer "$q2" hyperfide >/dev/null

# ---- fleet approvals are permission Asks, decided from either side
export HYPERFIDE_GH="$TMP/no-gh"
rc=0; CG_ROLE=main CG_AGENT=m "$CG" fleet pr 1 -f demo >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 4 ] || fail "the pr gate should wait (rc 4), got $rc"
ap="$("$CG" fleet approvals --json | pyjson 'print(d["approvals"][0]["id"], d["approvals"][0]["ask"])')"
apid=${ap% *}; gask=${ap#* }
[ "$(ask_field "$gask" 'a["kind"], a["title"], a["task"], a["blocking"], a["raised_by"]')" = \
  "permission pr of demo/wave-1 demo/wave-1 True m" ] || fail "gate Ask: $(ask_field "$gask" 'a')"
expect_rc 1 "$CG" ask answer "$gask" later
"$CG" ask answer "$gask" approve -m "ship it" >/dev/null
"$CG" fleet approvals --all --json | pyjson "a=[x for x in d['approvals'] if x['id']==$apid][0]; assert a['state']=='approved' and a['note']=='ship it', a" ||
    fail "answering the Ask did not approve the gate"
has "$(ev approval.decided)" "\"state\":\"approved\""
# the approval lets the next pr through (and is used up by it)
rc=0; CG_ROLE=main CG_AGENT=m "$CG" fleet pr 1 -f demo >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 4 ] || fail "an approved gate still waits"
# the next attempt asks again; fleet approve --reject answers its Ask
rc=0; CG_ROLE=main CG_AGENT=m "$CG" fleet pr 1 -f demo >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 4 ] || fail "a used approval should not cover a second pr (rc $rc)"
ap2="$("$CG" fleet approvals --json | pyjson 'print(d["approvals"][0]["id"], d["approvals"][0]["ask"])')"
apid2=${ap2% *}; gask2=${ap2#* }
[ "$gask2" != "$gask" ] || fail "the second gate reused the first Ask"
has "$("$CG" fleet approve "$apid2" --reject -m "not yet")" "rejected #$apid2"
[ "$(ask_field "$gask2" 'a["state"], a["answer"], a["note"]')" = "answered reject not yet" ] ||
    fail "fleet approve did not answer its Ask: $(ask_field "$gask2" 'a')"
expect_rc 1 "$CG" fleet approve 9999

echo "ask OK"
