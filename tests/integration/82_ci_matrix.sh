#!/usr/bin/env bash
# CI covers Hyperfide (service typecheck/build, deploy script syntax, the
# Postgres-backed qualification run) next to the C jobs, and a skipped case is
# reported as SKIP with a reason, never as PASS: in tests/run.sh and in the CI
# qualification driver. Needs no cg binary and no network.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
ci="$repo/.github/workflows/ci.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
has() { case "$1" in *"$2"*) : ;; *) fail "expected '$2' in:
$(printf '%s\n' "$1" | head -20)" ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "unexpected '$2' in:
$(printf '%s\n' "$1" | head -20)" ;; *) : ;; esac; }

[ -f "$ci" ] || fail "no workflow at $ci"

# ---- the workflow names each job, and each job carries its steps
job() {  # print the body of a top-level job (two-space indented key)
    awk -v j="  $1:" '$0 == j {on=1; next} on && /^  [A-Za-z0-9_-]+:$/ {exit} on {print}' "$ci"
}
for j in build-and-test hyperfide-service hyperfide-qualify; do
    [ -n "$(job "$j")" ] || fail "ci.yml has no job $j"
done
c=$(job build-and-test)
has "$c" "run: make"; has "$c" "make unit"; has "$c" "make integration"
s=$(job hyperfide-service)
has "$s" "working-directory: core/control-plane"
has "$s" "npm ci"; has "$s" "--noEmit"; has "$s" "npm run build"
has "$s" "working-directory: deploy/hyperfide"; has "$s" 'node --check "$f"'
q=$(job hyperfide-qualify)
has "$q" "image: postgres:"; has "$q" "DATABASE_URL:"; has "$q" "npm run build"
has "$q" "tests/hyperfide/qualify.py"; has "$q" "python3 - <<'QUALIFY'"

ls "$repo"/deploy/hyperfide/*.mjs >/dev/null 2>&1 || fail "no deploy/hyperfide/*.mjs for CI to check"
if command -v node >/dev/null 2>&1; then
    for f in "$repo"/deploy/hyperfide/*.mjs; do
        node --check "$f" || fail "node --check rejects $f"
    done
fi

# ---- tests/run.sh: pass, skip with reason, skip without reason, fail
mkdir -p "$TMP/rs/integration"
cp "$repo/tests/run.sh" "$TMP/rs/run.sh"
w() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$TMP/rs/integration/$1"; }
w 01_pass.sh 'echo fine'
w 02_skip.sh 'echo "probing"; echo "SKIP: no widget on PATH"; exit 77'
w 03_bare77.sh 'echo "skipped quietly"; exit 77'
w 04_fail.sh 'echo boom; exit 1'
set +e; out=$(CG=/bin/true bash "$TMP/rs/run.sh" 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "run.sh passed with a failing test: $out"
has "$out" "PASS 01_pass.sh"
has "$out" "SKIP 02_skip.sh: no widget on PATH"
hasnt "$out" "PASS 02_skip.sh"
has "$out" "FAIL 03_bare77.sh (exit 77 without a SKIP: reason line)"
hasnt "$out" "PASS 03_bare77.sh"
has "$out" "FAIL 04_fail.sh"
has "$out" "integration: 1 passed, 2 failed, 1 skipped"
rm "$TMP/rs/integration/03_bare77.sh" "$TMP/rs/integration/04_fail.sh"
out=$(CG=/bin/true bash "$TMP/rs/run.sh" 2>&1) || fail "run.sh failed on pass+skip: $out"
has "$out" "integration: 1 passed, 0 failed, 1 skipped"

# no suite test may announce a skip and still exit 0 (it would count as PASS)
bad=$(grep -nE '[Ss][Kk][Ii][Pp][^;]*"; *exit 0' "$repo"/tests/integration/*.sh || true)
[ -z "$bad" ] || fail "tests skip with exit 0 instead of 77:
$bad"

# ---- the CI qualification driver, extracted verbatim from ci.yml
awk '/python3 - <<.QUALIFY./ {on=1; next} on && /^ *QUALIFY$/ {exit} on {print}' "$ci" \
    | sed 's/^          //' > "$TMP/driver.py"
python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$TMP/driver.py" \
    || fail "QUALIFY driver in ci.yml does not parse"
r="$TMP/root"
mkdir -p "$r/tests/hyperfide/registrations/full" "$r/tests/hyperfide/manifests/tasks"
# Stub qualify.py: the verdict comes from the selected task, as the real gate prints it.
cat > "$r/tests/hyperfide/qualify.py" <<'PY'
import json, sys
task = sys.argv[sys.argv.index("--task") + 1]
print("progress line")
print(json.dumps({"status": "PASS" if task == "9.1" else "FAIL", "diagnostics": []}))
sys.exit(0 if task == "9.1" else 1)
PY
reg() {  # variant task required_env_json
    printf '{"schema_version":1,"variant":"%s","task":"%s","cases":["V-001"],"required_env":%s}\n' "$1" "$2" "$3" \
        > "$r/tests/hyperfide/registrations/$4.json"
}
man() { printf '{"registered_variant":"%s"}\n' "$1" > "$r/tests/hyperfide/manifests/tasks/$2.json"; }
reg task:9.1 9.1 '["HOME"]' 9.1;                       man task:9.1 9.1
reg task:9.2 9.2 '["HF_CI_MATRIX_SURELY_UNSET"]' 9.2;  man task:9.2 9.2
reg task:9.3 9.3 '[]' 9.3
reg full:V-001 9.4 '[]' full/V-001;                    man full:V-001 V-001
unset HF_CI_MATRIX_SURELY_UNSET
set +e; out=$(HF_QUALIFY_ROOT="$r" HF_QUALIFY_OUT="$TMP/qout" python3 "$TMP/driver.py" 2>&1); rc=$?; set -e
[ "$rc" -eq 1 ] || fail "driver should fail on a FAIL case, rc=$rc: $out"
has "$out" "PASS task:9.1"
has "$out" "SKIP task:9.2: required environment absent: HF_CI_MATRIX_SURELY_UNSET"
hasnt "$out" "PASS task:9.2"
has "$out" "SKIP task:9.3: no tracked manifest pins this variant"
hasnt "$out" "PASS task:9.3"
has "$out" "FAIL full:V-001 (FAIL, exit 1)"
has "$out" "qualify: 1 passed, 1 failed, 2 skipped"
rm "$r/tests/hyperfide/registrations/full/V-001.json"
out=$(HF_QUALIFY_ROOT="$r" HF_QUALIFY_OUT="$TMP/qout" python3 "$TMP/driver.py" 2>&1) || fail "driver failed with no FAIL: $out"
has "$out" "qualify: 1 passed, 0 failed, 2 skipped"
rm -r "$r/tests/hyperfide/registrations"
set +e; out=$(HF_QUALIFY_ROOT="$r" python3 "$TMP/driver.py" 2>&1); rc=$?; set -e
[ "$rc" -eq 1 ] || fail "driver must fail with no registrations, rc=$rc"
has "$out" "no tracked registrations"

# ---- task 2.14: fixture credential store, secret gating (D13), real SKIP reasons
q=$(job hyperfide-qualify)
has "$q" "name: materialise fixture credential store"
has "$q" 'bash tests/hyperfide/ci/credential-store.sh "$RUNNER_TEMP/hf-credentials"'
has "$q" 'echo "HF_CREDENTIAL_CONFIG_FILE=$config" >> "$GITHUB_ENV"'
[ "$(grep -c 'secrets\.' "$ci")" -eq 1 ] || fail "ci.yml must reference exactly one secret"
qstep=$(awk '/- name: qualify registered cases/ {on=1; print; next} on && /^      - / {exit} on {print}' "$ci")
has "$qstep" 'HF_RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}'
bad=$(grep -nE '(echo|printf|cat).*(secrets\.|RAILWAY_TOKEN)' "$ci" || true)
[ -z "$bad" ] || fail "ci.yml prints a secret:
$bad"

# the materialised store satisfies credentials.ts: private roots, 0600 file, five keys
store="$repo/tests/hyperfide/ci/credential-store.sh"
cfg=$(bash "$store" "$TMP/creds")
python3 - "$cfg" <<'PY' || fail "materialised credential store violates credentials.ts rules"
import json, os, stat, sys
f = sys.argv[1]
st = os.lstat(f)
assert os.path.isabs(f) and stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_mode & 0o077 == 0, "config file"
v = json.load(open(f))
assert sorted(v) == ["attachment_root", "schema_version", "secret_root", "sources", "targets"], sorted(v)
assert v["schema_version"] == 1 and v["sources"] == [] and v["targets"] == []
for r in (v["secret_root"], v["attachment_root"]):
    s = os.lstat(r)
    assert os.path.isabs(r) and os.path.realpath(r) == r and stat.S_ISDIR(s.st_mode), r
    assert s.st_uid == os.getuid() and s.st_mode & 0o022 == 0, r
PY
set +e; bash "$store" "$TMP/creds" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || fail "credential-store.sh reused an existing store"

# the real registrations: 9.1-9.4 run with the store, native and parity ones SKIP
# naming their variable, and the provider secret reaches only cases that declare it
r2="$TMP/real"
mkdir -p "$r2/tests/hyperfide"
cp -r "$repo/tests/hyperfide/registrations" "$repo/tests/hyperfide/manifests" "$r2/tests/hyperfide/"
mkdir -p "$r2/tests/hyperfide/registrations/live"
printf '{"schema_version":1,"variant":"live:railway","task":"live.1","cases":["V-001"],"required_env":["HF_RAILWAY_TOKEN"]}\n' \
    > "$r2/tests/hyperfide/registrations/live/railway.json"
printf '{"registered_variant":"live:railway"}\n' > "$r2/tests/hyperfide/manifests/live-railway.json"
cat > "$r2/tests/hyperfide/qualify.py" <<'PY'
import json, os, sys
task = sys.argv[sys.argv.index("--task") + 1] if "--task" in sys.argv else None
leaked = task != "live.1" and "HF_RAILWAY_TOKEN" in os.environ
print(json.dumps({"status": "FAIL" if leaked else "PASS", "diagnostics": ["provider secret leaked"] if leaked else []}))
sys.exit(1 if leaked else 0)
PY
drive() {
    env -u HF_RAILWAY_TOKEN -u HF_CREDENTIAL_CONFIG_FILE -u HF_TEST_NATIVE_CLAUDE_BINARY -u HF_TEST_NATIVE_CODEX_BINARY \
        -u HYPERFIDE_PARITY_V020_MANIFEST -u HYPERFIDE_PARITY_V025_MANIFEST \
        DATABASE_URL=postgres://ci@localhost/ci PGHOST=localhost PGPORT=5432 PGUSER=ci \
        HF_QUALIFY_ROOT="$r2" HF_QUALIFY_OUT="$TMP/qout2" "$@" python3 "$TMP/driver.py" 2>&1
}
set +e; out=$(drive); rc=$?; set -e
[ "$rc" -eq 0 ] || fail "driver failed on real registrations without the store: $out"
for t in 9.1 9.2 9.3 9.4; do
    has "$out" "SKIP task:$t: required environment absent: HF_CREDENTIAL_CONFIG_FILE"
done
has "$out" "live provider secret RAILWAY_TOKEN: absent"
has "$out" "SKIP live:railway: required environment absent: HF_RAILWAY_TOKEN (repository secret RAILWAY_TOKEN not set)"
set +e; out=$(drive HF_CREDENTIAL_CONFIG_FILE="$cfg"); rc=$?; set -e
[ "$rc" -eq 0 ] || fail "driver failed on real registrations with the store: $out"
for t in 9.1 9.2 9.3 9.4; do
    has "$out" "PASS task:$t"; hasnt "$out" "SKIP task:$t:"
done
has "$out" "SKIP task:14.3: required environment absent: HF_TEST_NATIVE_CLAUDE_BINARY, HF_TEST_NATIVE_CODEX_BINARY"
has "$out" "SKIP full:V-020: required environment absent: HYPERFIDE_PARITY_V020_MANIFEST"
has "$out" "SKIP full:V-025: required environment absent: HYPERFIDE_PARITY_V025_MANIFEST"
has "$out" "SKIP live:railway: required environment absent: HF_RAILWAY_TOKEN (repository secret RAILWAY_TOKEN not set)"
hasnt "$out" "PASS live:railway"
token="ci-matrix-sentinel-$$"
set +e; out=$(drive HF_CREDENTIAL_CONFIG_FILE="$cfg" HF_RAILWAY_TOKEN="$token"); rc=$?; set -e
[ "$rc" -eq 0 ] || fail "provider secret leaked to a case that does not declare it: $out"
has "$out" "live provider secret RAILWAY_TOKEN: present"
has "$out" "PASS live:railway"
hasnt "$out" "$token"

echo "82_ci_matrix OK"
