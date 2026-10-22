// Run one job on one pool worker and bring the result home: a git bundle, the evidence archive, the log and (qualify) the spec patch.
// usage: node run-job.mjs <state/ledger/pool/<worker>.json> <state/jobs/<id>.json>
//   qualify: check out the job's base on job/<id> (after the bundles of the jobs it runs `after`), run fleet.json qualify.cmd
//            (`cg spec done -f <feature> <task>` on a throwaway PostgreSQL cluster) and commit what it changed.
//   codex:   check out the base on task/<id>, run `codex exec` on the packet (gateway provider, approval never, the codify MCP server
//            with the ask tools, one gateway key per sandbox handed over through the exec environment) and commit what the agent left.
// Ledger state/ledger/jobs/<id>.json: done | review (codex exited 0 without commits) | failed. Exit 0 on done or review.
import {cfg, P, W, sdk, requireEnv, save, load, now, run, must, redact, sq, safe, fill, git, repoRoot, baseBundle, keyFor, gatewayModel,
  ledgerPath, updateWorker, readBytes, writePrivate} from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path';

requireEnv();
const [workerFile, jobFile] = process.argv.slice(2);
if (!workerFile || !jobFile) throw new Error('usage: run-job.mjs <worker-ledger.json> <job.json>');
const job = load(jobFile); const id = job.id, S = safe(id), kind = job.kind;
if (!['qualify', 'codex'].includes(kind)) throw new Error(`job ${id}: kind must be qualify or codex`);
const branch = `${kind === 'qualify' ? 'job' : 'task'}/${id}`;
const L = ledgerPath(id);
const worker = load(workerFile);
const baseCommit = git(repoRoot, 'rev-parse', '--verify', `${job.base}^{commit}`);
const prev = fs.existsSync(L) ? load(L) : null;
const rec = {id, kind, feature: job.feature, task: job.task, branch, worker: worker.name, sandboxId: worker.sandboxId, baseCommit,
  attempt: (prev?.attempt || 0) + 1, previous: prev ? {worker: prev.worker, state: prev.state, error: prev.error} : undefined,
  startedAt: now(), state: 'running', pid: process.pid, phases: []};
save(L, rec);
updateWorker(workerFile, {job: id, jobStartedAt: now(), pid: process.pid});
const phase = (name, r, extra = {}) => { rec.phases.push({name, at: now(), exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).slice(-1500), ...extra}); save(L, rec); };
const vars = {W, S, id, task: job.task, feature: job.feature, checkpointCommit: cfg.checkpointCommit};
let sb = null;

function codexConfig(model) {
  const url = (process.env[cfg.env.gatewayUrl] || '').trim();
  return [`model = ${JSON.stringify(model)}`, 'model_provider = "hfgateway"', 'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(cfg.codex.sandboxMode)}`, '',
    '[model_providers.hfgateway]', 'name = "Hyperfide gateway"', `base_url = ${JSON.stringify(url)}`, 'env_key = "HF_GATEWAY_KEY"',
    'wire_api = "responses"', 'request_max_retries = 30', 'stream_max_retries = 30', 'stream_idle_timeout_ms = 600000', '',
    '[mcp_servers.codify]', `command = ${JSON.stringify(`${W}/cg`)}`, 'args = ["mcp"]', `env = { CG_TASK = ${JSON.stringify(job.task)} }`, ''].join('\n');
}

try {
  // Predecessors (a requalification chain): their bundles travel too and this job starts from the last one's tip.
  const after = (job.after || []).map(a => { const f = ledgerPath(a); const l = fs.existsSync(f) ? load(f) : null;
    if (!l || l.state !== 'done') throw new Error(`job ${id} runs after ${a}, which is not done`); return l; });
  const start = after.length && after.at(-1).tip ? after.at(-1).tip : baseCommit;
  rec.start = start;
  const {Sandbox, config} = await sdk();
  sb = await Sandbox.connect(worker.sandboxId, config);
  phase('dirs', await must(sb, `mkdir -p /work/in /work/out /work/packets /work/evidence /work/logs /work/codex-home && rm -rf /work/out/${S}.* /work/in/*.bundle`, {timeoutSec: 60, label: 'dirs'}));
  const t0 = Date.now(); const bundles = [];
  const bb = baseBundle(baseCommit);
  if (bb) { await sb.files.write('/work/in/base.bundle', fs.readFileSync(bb), {mode: 0o600}); bundles.push('/work/in/base.bundle'); }
  for (const [i, l] of after.entries()) if (l.bundle && fs.existsSync(l.bundle)) {
    await sb.files.write(`/work/in/after-${i}.bundle`, fs.readFileSync(l.bundle), {mode: 0o600}); bundles.push(`/work/in/after-${i}.bundle`); }
  rec.phases.push({name: 'upload', at: now(), ms: Date.now() - t0, bundles: bundles.length}); save(L, rec);
  const fetches = bundles.map((b, i) => `git fetch -q ${b} '+refs/heads/*:refs/remotes/in${i}/*' && `).join('');
  phase('checkout', await must(sb, `git config --global user.name ${sq(cfg.git.name)} && git config --global user.email ${sq(cfg.git.email)} && ${fetches}git checkout -q -f -B ${sq(branch)} ${start} && git clean -fdq && touch /work/out/${S}.start && git rev-parse HEAD`, {cwd: W, timeoutSec: 1200, label: 'checkout'}));
  phase('prepare', await must(sb, fill(cfg.prepare, vars), {cwd: W, timeoutSec: 2400, label: 'prepare'}));

  if (kind === 'qualify') {
    const r = await run(sb, `(${fill(cfg.qualify.cmd, vars)}) > /work/out/${S}.log 2>&1; echo job_exit=$?`, {cwd: W, timeoutSec: job.timeoutSec || cfg.qualify.timeoutSec, label: 'qualify'});
    phase('qualify', r); rec.jobExit = Number((r.stdout.match(/job_exit=(\d+)/) || [])[1] ?? NaN);
    if (Number.isNaN(rec.jobExit)) rec.jobExit = null;
    await run(sb, `git add -A && (git diff --cached --quiet || git commit -q --no-verify -m ${sq(`spec: requalify ${job.feature} ${job.task} in a sandbox [spec:${job.feature}/${job.task}]`)}); git diff ${start} HEAD -- spec/${job.feature}/spec.kvx > /work/out/${S}.spec.patch`, {cwd: W, timeoutSec: 300, label: 'commit'});
  } else {
    const model = gatewayModel();
    await sb.files.write(`/work/packets/${S}.md`, fs.readFileSync(job.packet, 'utf8').split('{{BASE_COMMIT}}').join(baseCommit), {mode: 0o644});
    await sb.files.write('/work/codex-home/config.toml', codexConfig(model), {mode: 0o600});
    await sb.files.write('/work/.fleet_key', keyFor(worker.name) + '\n', {mode: 0o600});
    const cmd = `env CODEX_HOME=/work/codex-home HF_GATEWAY_KEY="$(cat /work/.fleet_key)" CG_TASK=${sq(job.task)} ${cfg.codex.bin} exec --json --skip-git-repo-check -C ${sq(W)} -o /work/out/${S}.last.md - < /work/packets/${S}.md > /work/out/${S}.agent.jsonl 2> /work/out/${S}.agent.err; echo agent_exit=$?; rm -f /work/.fleet_key; tail -c 1500 /work/out/${S}.agent.err`;
    const r = await run(sb, cmd, {cwd: W, timeoutSec: job.timeoutSec || cfg.codex.timeoutSec, label: 'codex'});
    phase('codex', r, {model});
    const m = r.stdout.match(/agent_exit=(\d+)/); rec.agentExit = m ? Number(m[1]) : null;
    rec.rateLimited = /\b429\b|too many requests|rate.?limit/i.test(r.stdout + r.stderr);
    await run(sb, `git add -A && (git diff --cached --quiet || git commit -q --no-verify -m ${sq(`Commit remaining worker changes for ${job.task} [spec:${job.feature}/${job.task}]`)}); (tail -c 6000 /work/out/${S}.last.md; echo; echo '--- transcript tail ---'; tail -c 20000 /work/out/${S}.agent.jsonl; echo; echo '--- stderr tail ---'; tail -c 4000 /work/out/${S}.agent.err) > /work/out/${S}.log 2>/dev/null`, {cwd: W, timeoutSec: 300, label: 'commit'});
  }

  const dirs = cfg.evidenceDirs.map(d => sq(fill(d, vars))).join(' ');
  const pack = await must(sb, `n=$(git rev-list --count ${start}..HEAD); echo commits=$n; echo tip=$(git rev-parse HEAD); find ${dirs} -type f -newer /work/out/${S}.start 2>/dev/null > /work/out/${S}.evlist; echo evidence_files=$(wc -l < /work/out/${S}.evlist); if [ -s /work/out/${S}.evlist ]; then tar czf /work/out/${S}.evidence.tgz -T /work/out/${S}.evlist; fi; if [ "$(git rev-list --count ${baseCommit}..HEAD)" -gt 0 ]; then git bundle create -q /work/out/${S}.bundle ${baseCommit}..${sq(branch)}; fi; git diff --name-only ${baseCommit} HEAD | head -200`, {cwd: W, timeoutSec: 600, label: 'pack'});
  phase('pack', pack);
  rec.commits = Number((pack.stdout.match(/commits=(\d+)/) || [])[1] || 0);
  rec.tip = (pack.stdout.match(/tip=([0-9a-f]{40})/) || [])[1] || null;
  rec.evidenceFiles = Number((pack.stdout.match(/evidence_files=(\d+)/) || [])[1] || 0);
  rec.files = pack.stdout.split('\n').filter(l => l && !/^(commits|tip|evidence_files)=/.test(l));
  const fetchTo = async (remote, local, text) => {
    try { const b = await readBytes(sb, remote); writePrivate(local, text ? redact(b.toString('utf8')) : b); return local; } catch { return null; } };
  rec.bundle = await fetchTo(`/work/out/${S}.bundle`, path.join(P.bundles, `${S}.bundle`));
  rec.evidence = rec.evidenceFiles ? await fetchTo(`/work/out/${S}.evidence.tgz`, path.join(P.evidence, `${S}.evidence.tgz`)) : null;
  rec.log = await fetchTo(`/work/out/${S}.log`, path.join(P.logs, `${S}.log`), true);
  if (kind === 'qualify') rec.specPatch = await fetchTo(`/work/out/${S}.spec.patch`, path.join(P.logs, `${S}.spec.patch`), true);
  if (kind === 'qualify') rec.state = rec.jobExit === 0 ? 'done' : 'failed';
  else rec.state = rec.agentExit === 0 ? (rec.commits > 0 && rec.bundle ? 'done' : 'review') : 'failed';
  if (rec.state === 'failed') rec.error = kind === 'qualify' ? `qualify exit ${rec.jobExit}` : `codex exit ${rec.agentExit}`;
} catch (e) {
  rec.state = 'failed'; rec.error = redact(e.message).slice(0, 4000);
} finally {
  // A failed or timed-out job must not leave the worker busy: stop the agent by process name (never a pattern from this command line),
  // drop the key file, release the claim.
  if (sb) { try { await run(sb, 'pkill -x codex; rm -f /work/.fleet_key; true', {timeoutSec: 60, label: 'cleanup'}); } catch {} }
  rec.finishedAt = now(); delete rec.pid; save(L, rec);
  updateWorker(workerFile, {job: null, pid: null, lastJob: id, lastState: rec.state});
}
console.log(JSON.stringify({id, kind, state: rec.state, commits: rec.commits ?? 0, bundle: rec.bundle ? path.basename(rec.bundle) : null, error: rec.error ? rec.error.slice(0, 300) : undefined}));
process.exitCode = ['done', 'review'].includes(rec.state) ? 0 : 1;
