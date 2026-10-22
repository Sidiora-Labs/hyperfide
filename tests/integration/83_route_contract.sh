#!/usr/bin/env bash
# Client route contract: every (component, action) the distributed C client
# can send must be an action a component manifest exports, and every exported
# action must be a client route or be declared server-only in
# tests/fixtures/route_contract/server_only.txt. Both sides are read from the
# sources, so a route or action added in one place and not the other fails
# here, by name. The binary is then driven in distributed mode to prove the
# extracted table is the one it dispatches on.
. "$(dirname "$0")/../lib.sh"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT="$REPO/src/hyperfide/client.c"
COMPONENTS="$REPO/services/hyperfide/components"
SERVER_ONLY="$FIXTURES/route_contract/server_only.txt"

# contract <client.c> <components dir> <server-only file> [routes out]
contract() {
    python3 -I - "$@" <<'PY'
import glob, json, os, re, sys
client, components, server_only = sys.argv[1:4]
routes_out = sys.argv[4] if len(sys.argv) > 4 else None
problems = []
src = open(client).read()

# The route table: every row between the declaration and its sentinel must
# parse, so a row the pattern misses is a failure, not a silent omission.
table = re.search(r'hf_routes25\[\]=\{\n(.*?)\n \{NULL,NULL,NULL,NULL\}', src, re.S)
if not table:
    sys.exit("FAIL: hf_routes25 table not found in " + client)
row = re.compile(r'^\s*\{"([^"]+)","([^"]+)"\s*,"([^"]+)","([^"]+)"\},\s*$')
routes = []
for line in table.group(1).splitlines():
    m = row.match(line)
    if not m:
        problems.append("unparsed route row: " + line.strip())
        continue
    routes.append(m.groups())
seen = set()
for command, sub, _, _ in routes:
    if (command, sub) in seen:
        problems.append("duplicate route: %s %s" % (command, sub))
    seen.add((command, sub))

# Fixed invocations outside the table (identity.describe) are client calls too.
sends = {(c, a): "route %s %s" % (cmd, sub) for cmd, sub, c, a in routes}
for c, a in re.findall(r'\\"component\\":\\"([^"\\%]+)\\",\\"action\\":\\"([^"\\%]+)\\"', src):
    sends.setdefault((c, a), "fixed call")

exports = {}
for path in sorted(glob.glob(os.path.join(components, '*.json'))):
    if os.path.basename(path) == 'schema.json':
        continue
    try:
        manifest = json.load(open(path))
        cid, actions = manifest['id'], manifest['actions']
    except (ValueError, KeyError, TypeError) as e:
        problems.append("unreadable manifest %s: %s" % (os.path.basename(path), e))
        continue
    if cid in exports:
        problems.append("duplicate component id: " + cid)
    exports[cid] = set(actions)

for (c, a), origin in sorted(sends.items()):
    if c not in exports:
        problems.append("%s -> %s %s: no component manifest with id %s" % (origin, c, a, c))
    elif a not in exports[c]:
        problems.append("%s -> %s %s: component %s exports no such action" % (origin, c, a, c))

whole, single = set(), set()
for n, line in enumerate(open(server_only), 1):
    line = line.split('#', 1)[0].split()
    if not line:
        continue
    if len(line) != 2:
        problems.append("server-only line %d: expected '<component> <action|*>'" % n)
        continue
    c, a = line
    if c not in exports:
        problems.append("server-only line %d: no component %s" % (n, c))
    elif a == '*':
        if any(sc == c for sc, _ in sends):
            problems.append("server-only line %d: component %s is client-routed; list its server-only actions instead" % (n, c))
        whole.add(c)
    elif a not in exports[c]:
        problems.append("server-only line %d: component %s exports no action %s" % (n, c, a))
    elif (c, a) in sends:
        problems.append("server-only line %d: %s %s is a client route" % (n, c, a))
    else:
        single.add((c, a))

for c in sorted(exports):
    for a in sorted(exports[c]):
        if (c, a) not in sends and c not in whole and (c, a) not in single:
            problems.append("action without a route: %s %s (add a client route or a server-only line)" % (c, a))

if routes_out:
    with open(routes_out, 'w') as out:
        for command, sub, _, _ in routes:
            out.write("%s %s\n" % (command, sub))
for p in problems:
    print("FAIL: " + p, file=sys.stderr)
if problems:
    sys.exit(1)
print("routes=%d sends=%d components=%d actions=%d server_only=%d" % (
    len(routes), len(sends), len(exports), sum(map(len, exports.values())),
    len(single) + sum(len(exports[c]) for c in whole)))
PY
}

# ---- positive: the tracked sources honour the contract in both directions
summary="$(contract "$CLIENT" "$COMPONENTS" "$SERVER_ONLY" "$TMP/routes")" || fail "route contract broken (see FAIL lines above)"
has "$summary" "routes="
routes=$(wc -l < "$TMP/routes")
[ "$routes" -ge 58 ] || fail "only $routes client routes extracted"

# ---- the binary dispatches on exactly the extracted table: in distributed
# mode a routed command passes route lookup and stops at the missing operation
# identities (no network); an unrouted one is refused as unsupported
cat > "$TMP/authority.json" <<'EOF'
{"schema_version":1,"mode":"distributed","authority_epoch":"0b0e1c2d-1111-4222-8333-444455556666"}
EOF
chmod 600 "$TMP/authority.json"
export HYPERFIDE_AUTHORITY_DESCRIPTOR="$TMP/authority.json"
unset HYPERFIDE_MODE
while read -r command sub; do
    out="$("$CG" "$command" "$sub" 2>&1)" && fail "$command $sub succeeded without identities"
    has "$out" '"code":"OPERATION_ID_REQUIRED"'
done < "$TMP/routes"
out="$("$CG" human route-contract-probe 2>&1)" && fail "unrouted command succeeded"
has "$out" '"code":"DISTRIBUTED_COMMAND_UNSUPPORTED"'
unset HYPERFIDE_AUTHORITY_DESCRIPTOR

# ---- negative: each direction of drift fails and names what drifted
neg="$TMP/neg"
mkdir -p "$neg"
cp -r "$COMPONENTS" "$neg/components"
cp "$CLIENT" "$neg/client.c"
cp "$SERVER_ONLY" "$neg/server_only.txt"

# a route whose action no manifest exports
sed 's/{"human","read","1.2","human.intent.read"}/{"human","read","1.2","human.intent.peek"}/' "$CLIENT" > "$neg/client.c"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "route without an action passed"
has "$out" "route human read -> 1.2 human.intent.peek: component 1.2 exports no such action"
# a route into a component that does not exist
sed 's/{"human","read","1.2",/{"human","read","9.99",/' "$CLIENT" > "$neg/client.c"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "route into a missing component passed"
has "$out" "route human read -> 9.99 human.intent.read: no component manifest with id 9.99"
# a fixed call whose action was dropped
sed 's/\\"action\\":\\"identity.describe\\"/\\"action\\":\\"identity.vanished\\"/' "$CLIENT" > "$neg/client.c"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "fixed call without an action passed"
has "$out" "fixed call -> 14.1 identity.vanished"
# a route row the extractor cannot parse
sed 's/{"human","read","1.2","human.intent.read"},/{"human","read",HF_C,"human.intent.read"},/' "$CLIENT" > "$neg/client.c"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "unparsed route row passed"
has "$out" "unparsed route row"
cp "$CLIENT" "$neg/client.c"

# an exported action with neither a route nor a server-only line
python3 -I - "$neg/components/1.2.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); m['actions'].append('human.ask.raise')
json.dump(m, open(sys.argv[1], 'w'), indent=2)
PY
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "action without a route passed"
has "$out" "action without a route: 1.2 human.ask.raise"
cp "$COMPONENTS/1.2.json" "$neg/components/1.2.json"
# a whole new component nobody routed or declared
printf '{"schema_version":1,"id":"99.1","task":"99.1","roles":["control"],"module":"x.js","entry":"createComponent","api_version":1,"actions":["probe.describe"],"requires":[]}\n' > "$neg/components/99.1.json"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "unrouted new component passed"
has "$out" "action without a route: 99.1 probe.describe"
rm "$neg/components/99.1.json"

# server-only lines must stay true: no stale, routed or wholesale-routed entries
printf '1.2 human.gone\n' >> "$neg/server_only.txt"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "stale server-only line passed"
has "$out" "component 1.2 exports no action human.gone"
cp "$SERVER_ONLY" "$neg/server_only.txt"
printf '1.2 human.intent.read\n' >> "$neg/server_only.txt"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "routed server-only line passed"
has "$out" "1.2 human.intent.read is a client route"
cp "$SERVER_ONLY" "$neg/server_only.txt"
printf '1.2 *\n' >> "$neg/server_only.txt"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "wholesale server-only routed component passed"
has "$out" "component 1.2 is client-routed"

# a removed server-only line resurfaces the action it covered
grep -v '^1.2 human.routine.receive$' "$SERVER_ONLY" > "$neg/server_only.txt"
out="$(contract "$neg/client.c" "$neg/components" "$neg/server_only.txt" 2>&1)" && fail "undeclared server action passed"
has "$out" "action without a route: 1.2 human.routine.receive"

echo "PASS: route contract ($summary)"
