#!/usr/bin/env bash
# Railway sandbox fleet toolkit (hyperfide-v21 4.10, req 4.10): deploy/hyperfide/sandbox runs end to end against a stub
# `railway` module (a sandbox is a directory, exec is a local bash with /work mapped into it, a checkpoint is a directory copy)
# and a stub codex binary. Proves: the credential gate and redaction, provision base/pool/list/teardown, gen-jobs for both
# kinds, dispatch of one qualify job (a real `cg spec done` on a cloned project) and one codex job, the retry of a failed job on
# a fresh worker, collect into sandbox/<id> branches with READY / NOT-QUALIFIED, and status. SKIP 77 without node.
. "$(dirname "$0")/../lib.sh"

command -v node >/dev/null 2>&1 || { echo "SKIP: node is not installed"; exit 77; }
REPO_SRC="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_SRC/deploy/hyperfide/sandbox"
KIT="$TMP/kit"; STUB="$TMP/railway"; PROJ="$TMP/proj"
mkdir -p "$KIT" "$STUB/bin"
# Keep the host binary outside the stub SDK's translated /work namespace.
cp "$CG" "$TMP/cg-host"
CG="$TMP/cg-host"
cp "$SRC"/*.mjs "$SRC"/*.py "$SRC/fleet.json" "$SRC/package.json" "$KIT/"

# --- stub SDK: same surface as railway@3.16.0 Sandbox (create/connect/list/exec/files/checkpoint/destroy) ---
mkdir -p "$KIT/node_modules/railway" "$KIT/node_modules/ws"
printf '{"name":"ws","type":"module","main":"index.js"}\n' > "$KIT/node_modules/ws/package.json"
printf 'export default class WebSocket { constructor() { throw new Error("stub ws is never opened"); } }\n' > "$KIT/node_modules/ws/index.js"
printf '{"name":"railway","version":"3.16.0","type":"module","main":"index.js"}\n' > "$KIT/node_modules/railway/package.json"
cat > "$KIT/node_modules/railway/index.js" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process'; import {randomUUID} from 'node:crypto';
const ROOT = process.env.STUB_RAILWAY_ROOT;
export class SandboxNotFoundError extends Error {}
const meta = id => path.join(ROOT, 'sandboxes', id, 'meta.json');
const auth = o => { if (!o || !o.token || o.authType !== 'bearer' || !o.environmentId || !o.webSocketImpl) throw new Error('stub: bad config'); };
const map = (fsRoot, s) => String(s).replace(/(^|[^\w.\/-])\/work\b/g, `$1${fsRoot}/work`);
export class Sandbox {
  constructor(id) { this.id = id; this.fsRoot = path.join(ROOT, 'sandboxes', id, 'fs'); }
  static async create(src, o) {
    if (typeof src !== 'string') { o = src; src = null; } auth(o);
    const id = 'sbx-' + randomUUID().slice(0, 8); const sb = new Sandbox(id);
    fs.mkdirSync(path.dirname(sb.fsRoot), {recursive: true});
    if (src) { const cp = path.join(ROOT, 'checkpoints', src); if (!fs.existsSync(cp)) throw new Error('stub: no checkpoint ' + src);
      spawnSync('cp', ['-a', cp, sb.fsRoot]); } else fs.mkdirSync(sb.fsRoot);
    fs.writeFileSync(meta(id), JSON.stringify({id, status: 'RUNNING', createdAt: new Date().toISOString(), env: o.env || {}, resources: o.resources}));
    return sb;
  }
  static async connect(id, o) { auth(o); if (!fs.existsSync(meta(id)) || JSON.parse(fs.readFileSync(meta(id))).status !== 'RUNNING') throw new SandboxNotFoundError(id); return new Sandbox(id); }
  static async list(o) { auth(o); const d = path.join(ROOT, 'sandboxes'); return fs.existsSync(d) ? fs.readdirSync(d).map(id => JSON.parse(fs.readFileSync(meta(id)))) : []; }
  exec(cmd, o = {}) {
    const fsRoot = this.fsRoot;
    return {result: async () => {
      fs.appendFileSync(path.join(ROOT, 'exec.log'), cmd + '\n');
      const r = spawnSync('bash', ['-c', map(fsRoot, cmd)], {encoding: 'utf8', timeout: (o.timeoutSec || 600) * 1000, maxBuffer: 64 << 20,
        env: {PATH: `${ROOT}/bin:${process.env.PATH}`, HOME: path.join(fsRoot, 'root'), GIT_CONFIG_NOSYSTEM: '1', STUB_FS: fsRoot, LANG: 'C', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CODEX_STUB_')))}});
      return {exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '', truncated: false, timedOut: !!r.error && r.error.code === 'ETIMEDOUT'};
    }};
  }
  get files() { const fsRoot = this.fsRoot; return {
    write: async (p, data, o = {}) => { const f = map(fsRoot, p); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, data); if (o.mode) fs.chmodSync(f, o.mode); },
    read: async (p, o = {}) => { const b = fs.readFileSync(map(fsRoot, p)); return o.format === 'bytes' ? new Uint8Array(b) : b.toString('utf8'); },
  }; }
  async checkpoint(name) { const cp = path.join(ROOT, 'checkpoints', name); fs.rmSync(cp, {recursive: true, force: true}); fs.mkdirSync(path.dirname(cp), {recursive: true});
    spawnSync('cp', ['-a', this.fsRoot, cp]); return {name}; }
  async destroy() { const m = JSON.parse(fs.readFileSync(meta(this.id))); m.status = 'DESTROYED'; fs.writeFileSync(meta(this.id), JSON.stringify(m)); fs.rmSync(this.fsRoot, {recursive: true, force: true}); }
}
EOF

# Sandbox process cleanup must not signal host processes from the local SDK stub.
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/bin/pkill"
chmod +x "$STUB/bin/pkill"

# --- stub codex: proves the packet, the config (gateway provider, approval never, codify MCP) and the key in its environment,
# echoes the key into its transcript (redaction must catch it), edits a file and exits 0. With CODEX_STUB_FAIL_ONCE its first
# run anywhere fails, so the retry must land on a different worker. ---
cat > "$STUB/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -u
[ "${1:-}" = exec ] || { echo "codex-stub 0.162.1"; exit 0; }
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
packet="$(cat)"
grep -q 'approval_policy = "never"' "$CODEX_HOME/config.toml" || { echo "no approval never" >&2; exit 3; }
grep -q '^\[mcp_servers.codify\]' "$CODEX_HOME/config.toml" || { echo "no codify mcp" >&2; exit 3; }
grep -q 'env_key = "HF_GATEWAY_KEY"' "$CODEX_HOME/config.toml" || { echo "no gateway provider" >&2; exit 3; }
[ -n "${HF_GATEWAY_KEY:-}" ] || { echo "no key in env" >&2; exit 3; }
case "$packet" in *"[spec:hyperfide-v21/"*) ;; *) echo "packet lacks the commit tag rule" >&2; exit 3;; esac
echo "{\"type\":\"turn.completed\",\"note\":\"key was $HF_GATEWAY_KEY\"}"
if [ -n "${CODEX_STUB_FAIL_ONCE:-}" ] && [ ! -e "$STUB_FS/../../../codex-failed-once" ]; then
  touch "$STUB_FS/../../../codex-failed-once"; echo "upstream said 500" >&2; exit 1
fi
echo "done by codex stub" > b.txt
sed -i 's/^status = "pending"$/status = "implemented"/' spec/hyperfide-v21/spec.kvx
git add -A && git commit -qm "codex stub change [spec:hyperfide-v21/4.1]"
echo "worker summary: changed b.txt" > "$out"
EOF
chmod +x "$STUB/bin/codex"

# --- a project to fleet: feature hyperfide (two chained tasks to requalify) and feature hyperfide-v21 (one codex task) ---
mkdir -p "$PROJ"; cd "$PROJ"
git init -q -b main . 2>/dev/null || git init -q .
git config user.email t@t; git config user.name t
printf 'export function alpha(): number {\n  return 1;\n}\n' > a.ts
printf '/cg\n/services/hyperfide/dist/\n.codegraph/\n' > .gitignore
"$CG" spec new hyperfide >/dev/null
"$CG" spec docs off >/dev/null
"$CG" spec start 1.1 >/dev/null
"$CG" spec done 1.1 >/dev/null
"$CG" spec add 2.1 --title "Alpha" --wave 2 --reqs 1.1 --verify "mkdir -p spec/hyperfide/evidence && echo receipt > spec/hyperfide/evidence/r-2.1.txt" >/dev/null
"$CG" spec add 2.2 --title "Beta" --wave 3 --requires 2.1 --reqs 1.1 --verify "true" >/dev/null
mkdir -p spec/hyperfide-v21
cat > spec/hyperfide-v21/spec.kvx <<'EOF'
[meta]
feature = "hyperfide-v21"

[task.4.1]
title = "A codex task"
status = "pending"
wave = 4
requires = []
touches = ["b.txt"]
verify_cmd = "test -f b.txt"
do_1 = "Write b.txt."
EOF
git add -A; git commit -qm "project"
git checkout -q -b side; echo side > side.txt; git add side.txt; git commit -qm side; git checkout -q main
CP_COMMIT="$(git rev-parse HEAD)"

# --- fleet.json for the stub: real clone step, cg copied instead of built, a fake service dist, the project as repo ---
python3 - "$KIT/fleet.json" "$PROJ" "$CG" <<'EOF'
import json, sys
p, proj, cg = sys.argv[1:]
c = json.load(open(p))
c['repo'] = proj
steps = {s[0]: s for s in c['base']['steps']}
c['base']['steps'] = [steps['clone'], ['cg', f'cd {{W}} && cp {cg} ./cg && ./cg --version', 120],
                      ['service', 'mkdir -p {W}/services/hyperfide/dist && echo index.js > {W}/services/hyperfide/dist/index.js && ls {W}/services/hyperfide/dist | head -1', 60],
                      ['index', 'cd {W} && ./cg init >/work/logs/init.log 2>&1', 300], ['tools', 'codex --version && git --version', 60]]
c['probe'] = 'cd {W} && ./cg --version && ls services/hyperfide/dist | head -1'
c['prepare'] = 'true'
c['qualify']['cmd'] = '(./cg spec start -f {feature} {task} >/dev/null 2>&1 || true); ./cg spec done -f {feature} {task}'
c['staggerMs'] = 0
c['backoff'] = {'initialMs': 100, 'maxMs': 200}
c['pool']['maxSize'] = 3
json.dump(c, open(p, 'w'), indent=2)
EOF
export HF_FLEET_CONFIG="$KIT/fleet.json" STUB_RAILWAY_ROOT="$STUB"
SECRET_TOKEN="rwtok-$(printf 'a%.0s' {1..30})"; SECRET_KEY1="gwkey-one-$(printf 'b%.0s' {1..24})"; SECRET_KEY2="gwkey-two-$(printf 'c%.0s' {1..24})"
cd "$KIT"

# negative: the credential gate refuses, naming the variable and never a value
unset HF_RAILWAY_API_TOKEN HF_RAILWAY_ENV_ID HF_GATEWAY_URL HF_GATEWAY_KEYS HF_GATEWAY_MODEL
if node provision.mjs pool 1 >"$TMP/gate.out" 2>&1; then fail "provision ran without credentials"; fi
grep -q 'refusing to start: environment variable(s) not set: HF_RAILWAY_API_TOKEN, HF_RAILWAY_ENV_ID' "$TMP/gate.out" || fail "gate message: $(cat "$TMP/gate.out")"
export HF_RAILWAY_API_TOKEN="$SECRET_TOKEN" HF_RAILWAY_ENV_ID="env-0000-1111-2222" HF_GATEWAY_URL="https://gateway.invalid/v1/secretpath" HF_GATEWAY_KEYS="$SECRET_KEY1,$SECRET_KEY2"
if node dispatch.mjs --dry >/dev/null 2>&1 && HF_GATEWAY_KEYS= node run-job.mjs x y >"$TMP/gate2.out" 2>&1; then fail "run-job ran without a gateway key"; fi
grep -q 'HF_GATEWAY_KEYS' "$TMP/gate2.out" || fail "run-job gate: $(cat "$TMP/gate2.out")"

# negative: pool refuses before a checkpoint is recorded
if node provision.mjs pool 1 >"$TMP/nocp.out" 2>&1; then fail "pool ran without a checkpoint"; fi
grep -q 'no checkpoint' "$TMP/nocp.out" || fail "no-checkpoint message: $(cat "$TMP/nocp.out")"

# provision base: clone local main from a bundle on top of a seed checkpoint, build, checkpoint, record in fleet.json
mkdir -p "$STUB/checkpoints/seed-base/root" "$STUB/checkpoints/seed-base/work"
git -C "$PROJ" checkout -q side
node provision.mjs base --from-checkpoint seed-base > "$TMP/base.out" 2>&1 || fail "provision base: $(cat "$TMP/base.out")"
git -C "$PROJ" checkout -q main
grep -q "checkpoint hf-base-${CP_COMMIT:0:10} commit $CP_COMMIT" "$TMP/base.out" || fail "base output: $(cat "$TMP/base.out")"
python3 -c "import json,sys; c=json.load(open('$KIT/fleet.json')); sys.exit(0 if c['checkpoint']=='hf-base-${CP_COMMIT:0:10}' and c['checkpointCommit']=='$CP_COMMIT' else 1)" || fail "fleet.json not updated"
[ -x "$STUB/checkpoints/hf-base-${CP_COMMIT:0:10}/work/hyperfide/cg" ] || fail "checkpoint lacks the built cg"
[ ! -e "$STUB/checkpoints/hf-base-${CP_COMMIT:0:10}/work/hyperfide/side.txt" ] || fail "base cloned a checked-out branch, not main"
grep -q '"state": "checkpointed"' "$KIT/state/ledger/base-${CP_COMMIT:0:10}.json" || fail "base ledger"
grep -q '"label": "upload"' "$KIT/state/ledger/base-${CP_COMMIT:0:10}.json" || fail "base timings"

# main moves after the checkpoint: jobs must receive the delta bundle
cd "$PROJ"; echo two > two.txt; git add two.txt; git commit -qm "after checkpoint"; BASE="$(git rev-parse HEAD)"; cd "$KIT"

# pool: two workers, probed; the cap holds; list names them
node provision.mjs pool 2 > "$TMP/pool.out" 2>&1 || fail "pool: $(cat "$TMP/pool.out")"
grep -q 'ready 2 of 2' "$TMP/pool.out" || fail "pool output: $(cat "$TMP/pool.out")"
if node provision.mjs pool 2 >"$TMP/cap.out" 2>&1; then fail "pool exceeded maxSize"; fi
grep -q 'the cap is 3' "$TMP/cap.out" || fail "cap message: $(cat "$TMP/cap.out")"
node provision.mjs list > "$TMP/list.out" || fail "list"
grep -q 'RUNNING .* hf-w001' "$TMP/list.out" && grep -q 'RUNNING .* hf-w002' "$TMP/list.out" || fail "list output: $(cat "$TMP/list.out")"

# gen-jobs: both kinds; the chain records `after`; unknown tasks refuse
python3 gen-jobs.py --requalify hyperfide 2.2 2.1 > "$TMP/gq.out" || fail "gen-jobs requalify"
python3 gen-jobs.py --v21 4.1 > "$TMP/gv.out" || fail "gen-jobs v21"
if python3 gen-jobs.py --v21 9.9 >/dev/null 2>&1; then fail "gen-jobs accepted an unknown task"; fi
python3 - "$KIT/state" "$BASE" <<'EOF' || fail "job files"
import json, sys
st, base = sys.argv[1:]
q1, q2, c = (json.load(open(f'{st}/jobs/{n}.json')) for n in ('hyperfide-2.1', 'hyperfide-2.2', 'v21-4.1'))
assert q1['kind'] == 'qualify' and q1['after'] == [] and q1['order'] == 1 and q1['base'] == base, q1
assert q2['after'] == ['hyperfide-2.1'] and q2['order'] == 2, q2
assert c['kind'] == 'codex' and c['packet'].endswith('state/packets/v21-4.1.md'), c
pk = open(c['packet']).read()
for s in ('Write b.txt.', 'test -f b.txt', '[spec:hyperfide-v21/4.1]', 'implemented', 'No Co-Authored-By', 'Never push', 'ASK.md', 'ask_raise'):
    assert s in pk, s
EOF

# Generic codex mode preserves the alias job id and appends the packet preamble.
printf 'Hyperfide packet preamble marker\n' > "$TMP/preamble.md"
HF_PACKET_PREAMBLE="$TMP/preamble.md" python3 gen-jobs.py --codex hyperfide-v21 4.1 > "$TMP/generic.out" || fail "gen-jobs codex"
grep -q 'Hyperfide packet preamble marker' state/packets/v21-4.1.md || fail "packet preamble"

# dispatch --dry plans without running
node dispatch.mjs --dry > "$TMP/dry.out" || fail "dry"
grep -q '"id":"hyperfide-2.1"' "$TMP/dry.out" && grep -q '"idleWorkers":2' "$TMP/dry.out" || fail "dry plan: $(cat "$TMP/dry.out")"
[ ! -d "$KIT/state/ledger/jobs" ] || fail "dry run wrote ledgers"

# dispatch: the codex job fails once and is retried on the other worker; the qualify chain runs in order
CODEX_STUB_FAIL_ONCE=1 node dispatch.mjs --cap 2 > "$TMP/dispatch.out" 2>&1 || fail "dispatch: $(cat "$TMP/dispatch.out")"
grep -q '"dispatched":3,"done":3' "$TMP/dispatch.out" || fail "dispatch summary: $(tail -5 "$TMP/dispatch.out")"
grep -q '"retry":"v21-4.1","failedOn":"hf-w00' "$TMP/dispatch.out" || fail "no retry on a fresh worker: $(cat "$TMP/dispatch.out")"
python3 - "$KIT/state/ledger/jobs" "$BASE" <<'EOF' || fail "ledgers: $(cat "$KIT"/state/ledger/jobs/*.json | head -80)"
import json, sys
d, base = sys.argv[1:]
c = json.load(open(f'{d}/v21-4.1.json'))
assert c['state'] == 'done' and c['attempt'] == 2 and c['previous']['state'] == 'failed' and c['worker'] != c['previous']['worker'], c
assert c['commits'] == 1 and c['bundle'].endswith('v21-4.1.bundle') and c['agentExit'] == 0 and c['baseCommit'] == base, c
assert [p['name'] for p in c['phases']][:4] == ['dirs', 'upload', 'checkout', 'prepare'] and c['phases'][1]['bundles'] == 1, c['phases']
q1, q2 = (json.load(open(f'{d}/hyperfide-{t}.json')) for t in ('2.1', '2.2'))
assert q1['state'] == 'done' and q1['jobExit'] == 0 and q1['commits'] == 1 and q1['evidenceFiles'] >= 1 and q1['evidence'], q1
assert q2['state'] == 'done' and q2['start'] == q1['tip'] and q2['phases'][1]['bundles'] == 2, q2
for l in (c, q1, q2):
    assert l['finishedAt'] and 'pid' not in l, l
EOF
for w in 001 002; do grep -q '"job": null' "$KIT/state/ledger/pool/hf-w$w.json" || fail "worker hf-w$w left busy"; done
[ -z "$(find "$STUB/sandboxes" -name .fleet_key)" ] || fail "gateway key left in a sandbox"

# redaction: no credential value in any local state, log or dispatch output; the transcript shows the redaction
if grep -rqF -e "$SECRET_TOKEN" -e "$SECRET_KEY1" -e "$SECRET_KEY2" -e "gateway.invalid/v1/secretpath" -e "env-0000-1111-2222" "$KIT/state" "$TMP"/*.out; then fail "a credential reached local state or output"; fi
grep -q 'key was \[REDACTED\]' "$KIT/state/logs/v21-4.1.log" || fail "transcript not captured or not redacted"
grep -q 'model = "cx/gpt-6.1-sol"' "$STUB/sandboxes/$(python3 -c "import json;print(json.load(open('$KIT/state/ledger/jobs/v21-4.1.json'))['sandboxId'])")/fs/work/codex-home/config.toml" || fail "default model"

# collect: sandbox/<id> branches in the project, evidence unpacked, READY; main untouched and still checked out
MAIN_BEFORE="$(git -C "$PROJ" rev-parse main)"
node collect-all.mjs > "$TMP/collect.out" 2>&1 || fail "collect-all: $(cat "$TMP/collect.out")"
grep -q '"ready":3,"notQualified":0' "$TMP/collect.out" || fail "collect summary: $(cat "$TMP/collect.out") $(cat "$KIT"/state/ledger/*.txt)"
[ "$(git -C "$PROJ" rev-parse main)" = "$MAIN_BEFORE" ] && [ "$(git -C "$PROJ" rev-parse --abbrev-ref HEAD)" = main ] || fail "collect moved main"
git -C "$PROJ" show sandbox/v21-4.1:b.txt | grep -q 'done by codex stub' || fail "codex branch content"
git -C "$PROJ" show sandbox/hyperfide-2.2:spec/hyperfide/spec.kvx | awk '/^\[task.2.1\]/{t=1} /^\[task.2.2\]/{t=2} t&&/^status/{print t, $3}' > "$TMP/st.out"
grep -q '1 "done"' "$TMP/st.out" && grep -q '2 "done"' "$TMP/st.out" || fail "requalified statuses: $(cat "$TMP/st.out")"
[ -f "$KIT/state/evidence/hyperfide-2.1/READY.txt" ] || fail "READY.txt"
[ -f "$KIT/state/evidence/hyperfide-2.1/spec/hyperfide/evidence/r-2.1.txt" ] || fail "evidence not unpacked"
[ -f "$KIT/state/evidence/hyperfide-2.1/hyperfide-2.1.spec.patch" ] || fail "spec patch"
grep -q '^READY v21-4.1 codex hyperfide-v21/4.1 sandbox/v21-4.1@' "$KIT/state/ledger/v21-4.1.txt" || fail "ledger line: $(cat "$KIT/state/ledger/v21-4.1.txt")"
node collect.mjs v21-4.1 | grep -q '"already":"READY"' || fail "re-collect is not idempotent"

# negative: a qualify job whose cg spec done fails twice lands in failed/ and collects NOT-QUALIFIED
cd "$PROJ"; "$CG" spec add 2.3 --title "Gamma" --wave 4 --reqs 1.1 --verify "false" >/dev/null; git add -A; git commit -qm "gamma"; cd "$KIT"
python3 gen-jobs.py --requalify hyperfide 2.3 >/dev/null || fail "gen-jobs 2.3"
node dispatch.mjs > "$TMP/d2.out" 2>&1 || fail "dispatch 2: $(cat "$TMP/d2.out")"
grep -q '"settled":"hyperfide-2.3","state":"failed"' "$TMP/d2.out" || fail "second failure: $(cat "$TMP/d2.out")"
[ -f "$KIT/state/ledger/failed/hyperfide-2.3.json" ] && [ ! -f "$KIT/state/ledger/jobs/hyperfide-2.3.json" ] || fail "failed ledger not moved"
node collect-all.mjs > "$TMP/c2.out" 2>&1 || fail "collect 2"
grep -q '^NOT-QUALIFIED hyperfide-2.3 .*reason=failed: qualify exit 1' "$TMP/c2.out" || fail "NOT-QUALIFIED: $(cat "$TMP/c2.out")"
[ -f "$KIT/state/evidence/hyperfide-2.3/NOT-QUALIFIED.txt" ] || fail "NOT-QUALIFIED.txt"

# status
python3 status.py --detail > "$TMP/status.out" || fail "status"
grep -q "pool: {'ready': 2} busy: 0 idle: 2" "$TMP/status.out" || fail "status pool: $(cat "$TMP/status.out")"
grep -q 'jobs: queued=0 running=0 done=3 review=0 failed=1' "$TMP/status.out" || fail "status jobs: $(cat "$TMP/status.out")"
grep -q "collected: {'READY': 3, 'NOT-QUALIFIED': 1}" "$TMP/status.out" || fail "status verdicts: $(cat "$TMP/status.out")"
grep -q 'worker hf-w002 .*last=' "$TMP/status.out" || fail "status workers: $(cat "$TMP/status.out")"

# Watch starts empty, discovers a newly generated job, and drains on STOP.
node dispatch.mjs --watch --cap 1 > "$TMP/watch.out" 2>&1 &
WATCH_PID=$!
for i in {1..100}; do [ -f state/dispatch-loop.json ] && break; sleep 0.1; done
cd "$PROJ"
"$CG" spec add 2.4 --title "Watch task" --wave 5 --reqs 1.1 --verify "true" >/dev/null
git add -A; git commit -qm "watch task"
cd "$KIT"
python3 gen-jobs.py --requalify hyperfide 2.4 >/dev/null || fail "watch gen-jobs"
for i in {1..300}; do
  if [ -f state/ledger/jobs/hyperfide-2.4.json ] && grep -q '"state": "done"' state/ledger/jobs/hyperfide-2.4.json; then break; fi
  kill -0 "$WATCH_PID" 2>/dev/null || fail "watch exited early: $(cat "$TMP/watch.out")"
  sleep 0.1
done
touch state/STOP
for i in {1..100}; do kill -0 "$WATCH_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$WATCH_PID" 2>/dev/null; then kill "$WATCH_PID"; fail "watch ignored STOP"; fi
wait "$WATCH_PID" || fail "watch failed: $(cat "$TMP/watch.out")"
python3 - <<'EOF' || fail "watch snapshot"
import json
s = json.load(open('state/dispatch-loop.json'))
assert not s['running'] and 'queued' in s and 'backoff' in s, s
assert {'id': 'hyperfide-2.4', 'state': 'done'} in s['settled'], s
EOF

# teardown destroys the pool and records it
node provision.mjs teardown > "$TMP/td.out" 2>&1 || fail "teardown: $(cat "$TMP/td.out")"
grep -q 'teardown 2 of 2' "$TMP/td.out" || fail "teardown output: $(cat "$TMP/td.out")"
node provision.mjs list | grep -q 'RUNNING' && fail "sandboxes survive teardown"
grep -q '"state": "destroyed"' "$KIT/state/ledger/pool/hf-w001.json" || fail "pool ledger after teardown"
# the toolkit's private state is owner-only
[ "$(stat -c %a "$KIT/state/ledger/jobs/v21-4.1.json")" = 600 ] || fail "ledger mode"
echo "PASS: 96_sandbox_toolkit"
