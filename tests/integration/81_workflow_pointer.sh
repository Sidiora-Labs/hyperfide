#!/usr/bin/env bash
# hyperfide-v21 1.3: spec/workflow.kvx is the one workflow source. The
# generated agent files (CLAUDE.md, AGENTS.md, agent-context.md) carry only
# a pointer to it, and no rule in it names a library the binary does not link.
. "$(dirname "$0")/../lib.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WF="$ROOT/spec/workflow.kvx"
[ -f "$WF" ] || fail "no spec/workflow.kvx"

# ---- render the real workflow in a scratch repo: the kvx must parse
mkdir -p "$TMP/repo/spec"
cp "$WF" "$TMP/repo/spec/workflow.kvx"
active="$(sed -n 's/^active_feature *= *"\(.*\)"/\1/p' "$WF" | head -1)"
[ -n "$active" ] || fail "workflow.kvx declares no active_feature"
[ -f "$ROOT/spec/$active/spec.kvx" ] || fail "active feature spec/$active missing"
cp -r "$ROOT/spec/$active" "$TMP/repo/spec/$active"
cd "$TMP/repo"
git init -q .
"$CG" spec render >/dev/null 2>&1 || fail "spec render failed: workflow.kvx does not parse"
"$CG" spec render --check >/dev/null 2>&1 || fail "render is not idempotent"

# a broken kvx must be refused, or the parse check above proves nothing
cp spec/workflow.kvx "$TMP/wf.good"
printf '[principle\nbroken = "x"\n' >> spec/workflow.kvx
expect_rc 1 "$CG" spec render
cp "$TMP/wf.good" spec/workflow.kvx

"$CG" init >/dev/null 2>&1 || fail "init failed"
"$CG" agentmd > "$TMP/agent-context.md" || fail "agentmd failed"

LIBS="$(make -s -C "$ROOT" print-link-libs)"
[ -n "$LIBS" ] || fail "make print-link-libs printed nothing"

cat > "$TMP/check.py" <<'PY'
import re, sys

def kvx(path):
    """section -> {key: [string values]} for the subset workflow.kvx uses"""
    out, sec = {}, None
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.fullmatch(r"\[([^\]]+)\]", line)
        if m:
            sec = m.group(1); out.setdefault(sec, {}); continue
        m = re.match(r"([A-Za-z0-9_]+)\s*=\s*(.*)", line)
        if not m or sec is None:
            raise SystemExit(f"unparsable kvx line: {line}")
        out[sec][m.group(1)] = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2))
    return out

RULE_SECTIONS = ["principle", "hard_rules", "human", "asks", "publication", "memory"]

def pointer_problems(text, wf, specrel, active):
    """a generated file may hold the pointer, the owners line, the active
    feature, the loop and the section index; nothing else"""
    probs = []
    if f"`{specrel}/workflow.kvx`" not in text:
        probs.append("no pointer to workflow.kvx")
    if f"`{specrel}/{active}/spec.kvx`" not in text:
        probs.append("no active feature path")
    heads = [l for l in text.splitlines() if l.startswith("## ")]
    if heads != ["## Active feature", "## The loop (every session)", "## Where the rules are"]:
        probs.append(f"unexpected sections {heads}")
    for sec in RULE_SECTIONS:
        for key, vals in wf.get(sec, {}).items():
            for v in vals:
                if len(v) > 20 and v in text:
                    probs.append(f"[{sec}] {key} duplicated into the generated file")
    return probs

def dependency_problems(wf, linked):
    """every library a principle or hard rule names must be one the Makefile links"""
    linked = {l[2:] for l in linked.split() if l.startswith("-l")}
    linked |= {"c"}                      # libc is implicit
    alias = {"sqlite": "sqlite3", "libc": "c", "openssl": "ssl", "zlib": "z",
             "libgit2": "git2", "libcurl": "curl", "libcrypto": "crypto",
             "libssl": "ssl", "libsqlite3": "sqlite3", "libz": "z",
             "libuv": "uv", "libpthread": "pthread", "libm": "m"}
    vocab = r"(sqlite3?|libsqlite3|libc|curl|libcurl|crypto|libcrypto|ssl|libssl|openssl|zlib|libz|libgit2|libuv|pcre2?|libxml2|libyaml|zstd|lzma|gnutls|gcrypt|readline|ncurses|libpthread|libm)"
    probs = []
    for sec in ("principle", "hard_rules"):
        for key, vals in wf.get(sec, {}).items():
            for v in vals:
                names = re.findall(r"(?<![\w./-])" + vocab + r"(?![\w-])", v)
                names += re.findall(r"(?<![\w])-l([a-z0-9_+]+)", v)
                for n in names:
                    if alias.get(n, n) not in linked:
                        probs.append(f"[{sec}] {key} names {n}, which the Makefile does not link")
    return probs

mode, wfpath = sys.argv[1], sys.argv[2]
wf = kvx(wfpath)
if mode == "pointer":
    specrel, active = sys.argv[3], sys.argv[4]
    bad = []
    for f in sys.argv[5:]:
        bad += [f"{f}: {p}" for p in pointer_problems(open(f, encoding="utf-8").read(), wf, specrel, active)]
elif mode == "deps":
    bad = dependency_problems(wf, sys.argv[3])
elif mode == "status":
    bad = [] if "blocked" in wf.get("status_values", {}).get("task", []) else ["status_values.task lacks blocked"]
    for sec in ("human", "asks", "publication"):
        if not wf.get(sec):
            bad.append(f"[{sec}] missing")
    kinds = wf.get("asks", {}).get("kinds", [])
    if sorted(kinds) != sorted(["secret", "variable", "permission", "decision", "question"]):
        bad.append(f"asks kinds {kinds}")
    for k in kinds:
        if wf["asks"].get(k, [None])[0] not in ("block", "proceed-and-flag"):
            bad.append(f"ask kind {k} has no default policy")
for b in bad:
    print(b)
sys.exit(1 if bad else 0)
PY

# ---- positive: the generated files are pointers, the kvx is complete and
# names only linked libraries
python3 "$TMP/check.py" pointer spec/workflow.kvx spec "$active" \
    CLAUDE.md AGENTS.md || fail "generated files are not pointer-only"
python3 "$TMP/check.py" status spec/workflow.kvx || fail "workflow.kvx incomplete"
python3 "$TMP/check.py" deps spec/workflow.kvx "$LIBS" \
    || fail "workflow.kvx names an unlinked dependency"
ctx="$(cat "$TMP/agent-context.md")"
has "$ctx" '`spec/workflow.kvx`'
has "$ctx" "\`spec/$active/spec.kvx\`"
cmp -s CLAUDE.md AGENTS.md || fail "CLAUDE.md and AGENTS.md differ"

# ---- negative: each check catches what it guards
cp CLAUDE.md "$TMP/dup.md"
rule="$(sed -n 's/^no_fakes *= *"\(.*\)"/\1/p' spec/workflow.kvx)"
[ -n "$rule" ] || fail "hard_rules no_fakes missing"
printf '\n## Hard rules\n\n- %s\n' "$rule" >> "$TMP/dup.md"
out="$(python3 "$TMP/check.py" pointer spec/workflow.kvx spec "$active" "$TMP/dup.md" || true)"
has "$out" "unexpected sections"
has "$out" "no_fakes duplicated"

cp spec/workflow.kvx "$TMP/wf.dep"
sed -i 's/^no_fakes *= *"/no_fakes = "Link zlib for speed. /' "$TMP/wf.dep"
out="$(python3 "$TMP/check.py" deps "$TMP/wf.dep" "$LIBS" || true)"
has "$out" "names zlib"
sed -i 's/Link zlib for speed. /Use sqlite and libc. /' "$TMP/wf.dep"
python3 "$TMP/check.py" deps "$TMP/wf.dep" "$LIBS" >/dev/null \
    || fail "linked libraries were flagged"
python3 "$TMP/check.py" deps "$TMP/wf.dep" "-lpthread" >/dev/null \
    && fail "an unlinked sqlite was not flagged"

sed 's/"blocked", //' spec/workflow.kvx > "$TMP/wf.nob"
expect_rc 1 python3 "$TMP/check.py" status "$TMP/wf.nob"

echo "ok 81_workflow_pointer"
