#!/usr/bin/env bash
# A usable docs claims ledger (hyperfide-v21 8.2, req 8.1).
#
# The ledger (.codegraph/docs/<feature>/claims.kvx and required.kvx) used to
# claim every graph "entry point": every symbol of every test file, every type
# and macro, every name quoted anywhere, every fixture route. Measured on this
# repository at 7e12392e (clean clone, full-baseline closure, 1480 files,
# 18,048 symbols, 55 routes): 18,103 required claims (18,048 symbols + 55
# routes), and the live incremental ledger of feature `hyperfide` held 14,643.
# `docs check` also wrote that ledger: it rewrote required.kvx on every run and
# seeded claims.kvx when absent (the `hyperfide` ledger exists only because
# check wrote it), and it created the docs directory.
#
# Now a claim is a public symbol or a route, decided by the language, not by
# usage: never a test or fixture path; in a C/C++ header its functions and
# types (not macros); elsewhere what the parser marks exported or "public";
# Go's capitalised names. On the same clone the required surface is 2,734
# (all symbols: about 1,900 services/hyperfide TypeScript exports, about 700
# src/*.h functions and types, the rest Python, .mjs and Go exports; all 55
# routes live under tests/fixtures and are excluded), 15% of before.
#
# "Bounded" here is exact: the fixture below has 6 public items (2 header
# items, 2 TypeScript exports, 1 Python public function, 1 route) and 9
# non-public ones (a static function, a header-less C function, a macro, an
# unexported TS function, a _private Python function, main, a test-file
# export, a test-file route, a test-file C function). The ledger must hold
# exactly the 6, so it is bounded by the public surface, not by the code.
#
# Read-only: `docs check` never writes claims.kvx or required.kvx, never seeds
# a missing ledger, never creates the docs directory; it derives the required
# surface in memory. Its only writes are its verdict (check.json, verified)
# inside a directory `docs packet` created. `docs packet` is the ledger writer.
. "$(dirname "$0")/../lib.sh"

sum() { sha256sum "$@" | awk '{print $1}' | tr '\n' ' '; }

mkdir -p "$TMP/p"
"$CG" spec new ledger-demo --root "$TMP/p" >/dev/null
cd "$TMP/p"
"$CG" init >/dev/null

# A check before any packet: nothing to read, and nothing may be created.
out="$("$CG" docs check 2>&1)" && fail "check passed with no packet"
has "$out" "claim ledger is missing"
[ ! -e .codegraph/docs/ledger-demo ] \
    || fail "check created the docs directory: $(ls -A .codegraph/docs/ledger-demo)"

"$CG" spec start 1.1 >/dev/null
mkdir -p include src lib py tests
cat > include/api.h <<'EOF'
#define API_GUARD 1
typedef struct Handle { int fd; } Handle;
int api_open(void);
EOF
cat > src/api.c <<'EOF'
#include "../include/api.h"
static int helper(void) { return 1; }
int not_in_header(void) { return 2; }
int api_open(void) { return helper() + not_in_header(); }
EOF
printf 'int main(void) { return 0; }\n' > main.c
cat > lib/util.ts <<'EOF'
export function exportedFn(): number { return hiddenFn(); }
function hiddenFn(): number { return 1; }
export class ExportedThing { run(): number { return 2; } }
EOF
cat > py/mod.py <<'EOF'
def public_fn():
    return _private_fn()


def _private_fn():
    return 1
EOF
printf "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\n" > server.js
printf "export function testOnly(): number { return 0; }\n" > tests/only.ts
printf "const app = require('express')();\napp.get('/fixture', (_q, r) => r.send('x'));\n" > tests/server.js
printf 'int test_helper(void) { return 0; }\n' > tests/helper.c
printf '# Ledger Demo\n' > README.md
"$CG" commit -m "implement ledger demo" >/dev/null
"$CG" spec done 1.1 >/dev/null

"$CG" docs packet >/dev/null
L=.codegraph/docs/ledger-demo
[ -s "$L/claims.kvx" ] && [ -s "$L/required.kvx" ] \
    || fail "docs packet did not write the ledger"

# The claim count is bounded by the public surface: exactly these six.
python3 - "$L/claims.kvx" "$L/required.kvx" <<'PY'
import re, sys
want = {("symbol", "api_open"), ("symbol", "Handle"), ("symbol", "exportedFn"),
        ("symbol", "ExportedThing"), ("symbol", "public_fn"),
        ("route", "GET /health")}
for path, sec in ((sys.argv[1], "claim"), (sys.argv[2], "required")):
    text = open(path).read()
    blocks = re.split(r"^\[%s\.\d+\]$" % sec, text, flags=re.M)[1:]
    got = set()
    for b in blocks:
        t = re.search(r'^type\s*=\s*"([^"]*)"', b, re.M).group(1)
        v = re.search(r'^value\s*=\s*"([^"]*)"', b, re.M).group(1)
        got.add((t, v))
    assert len(blocks) == len(want), (path, len(blocks), sorted(got))
    assert got == want, (path, sorted(got ^ want))
PY
for private in helper not_in_header API_GUARD hiddenFn _private_fn main \
               testOnly test_helper /fixture; do
    hasnt "$(cat "$L/claims.kvx")" "\"$private\""
done

# check is read-only for the ledger, failing or passing.
before="$(sum "$L/claims.kvx" "$L/required.kvx")"
out="$("$CG" docs check 2>&1)" && fail "unmapped ledger passed"
has "$out" "required public surface ledger contains 6 item(s)"
has "$out" "ok  required symbol api_open is documented"
has "$out" "FAIL  claim api_open appears in mapped document"
[ "$(sum "$L/claims.kvx" "$L/required.kvx")" = "$before" ] \
    || fail "docs check modified the ledger"

# An edited required.kvx is neither trusted nor repaired by check.
printf '[required.1]\ntype = "path"\nvalue = "main.c"\n' > "$L/required.kvx"
tampered="$(sum "$L/required.kvx")"
out="$("$CG" docs check 2>&1)" && fail "tampered required ledger passed"
has "$out" "required public surface ledger contains 6 item(s)"
[ "$(sum "$L/required.kvx")" = "$tampered" ] \
    || fail "docs check rewrote required.kvx"

# A missing claims.kvx is reported, not seeded.
mv "$L/claims.kvx" "$TMP/claims.saved"
out="$("$CG" docs check 2>&1)" && fail "check passed without a claim ledger"
has "$out" "claim ledger is missing"
[ ! -e "$L/claims.kvx" ] || fail "docs check seeded claims.kvx"
mv "$TMP/claims.saved" "$L/claims.kvx"

# A passing check still leaves the ledger byte for byte as the agent wrote it.
cat > "$L/claims.kvx" <<'EOF'
[coverage]
user                 = "README.md"
developer            = "docs/development.md"
release_or_migration = "CHANGELOG.md"
exclusions           = "No generated API reference; this fixture is a library."
unresolved           = ""

[claim.1]
type     = "symbol"
value    = "api_open"
document = "docs/development.md"
evidence = "include/api.h:3"

[claim.2]
type     = "symbol"
value    = "Handle"
document = "docs/development.md"
evidence = "include/api.h:2"

[claim.3]
type     = "symbol"
value    = "exportedFn"
document = "docs/development.md"
evidence = "lib/util.ts:1"

[claim.4]
type     = "symbol"
value    = "ExportedThing"
document = "docs/development.md"
evidence = "lib/util.ts:3"

[claim.5]
type     = "symbol"
value    = "public_fn"
document = "docs/development.md"
evidence = "py/mod.py:1"

[claim.6]
type     = "route"
value    = "GET /health"
document = "README.md"
evidence = "server.js:2"
EOF
"$CG" spec docs start >/dev/null
mkdir -p docs
printf '# Ledger Demo\n\nHealth is `GET /health`. See [development](docs/development.md).\n' > README.md
printf '# Development\n\n`api_open`, `Handle`, `exportedFn`, `ExportedThing`, `public_fn`.\n' > docs/development.md
printf '# Changelog\n\nDocumented the public surface.\n' > CHANGELOG.md
before="$(sum "$L/claims.kvx" "$L/required.kvx")"
out="$("$CG" docs check 2>&1)" || fail "documented public surface did not pass:
$out"
has "$out" "documentation check: PASS"
[ "$(sum "$L/claims.kvx" "$L/required.kvx")" = "$before" ] \
    || fail "a passing docs check modified the ledger"
[ -s "$L/verified" ] || fail "a passing check did not record its verdict"

# docs packet remains the writer: it re-derives required.kvx, keeps claims.kvx.
claims_sum="$(sum "$L/claims.kvx")"
"$CG" docs packet >/dev/null
[ "$(sum "$L/claims.kvx")" = "$claims_sum" ] || fail "packet overwrote claims.kvx"
[ "$(grep -c '^\[required\.' "$L/required.kvx")" = 6 ] \
    || fail "packet did not re-derive required.kvx"

echo "97_docs_ledger: ok"
