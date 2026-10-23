// Run the queued jobs (state/jobs/<id>.json) on free pool workers, one run-job.mjs child per job, and stay until all have settled.
// usage: node dispatch.mjs [--dry] [--cap N] [--stagger-ms N] [--only id,id] [--kind qualify|codex] [--workers hf-w001,...]
//   queued: a job file with no ledger, or whose ledger failed once (the retry, on a different worker than the failed attempt).
//   done and review ledgers are terminal; a second failure moves the ledger to state/ledger/failed/<id>.json.
//   A job with `after` waits until those jobs are done. Wave then id order; at most --cap (fleet.json cap) jobs in flight,
//   starts --stagger-ms apart. A failure that names HTTP 429 pauses new starts (backoff.initialMs, doubling to backoff.maxMs).
import {cfg, P, requireEnv, load, save, now, sleep, opts, safe, poolWorkers, updateWorker, ledgerPath, failedPath, baseBundle, git, repoRoot, here} from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';

const o = opts(process.argv.slice(2), ['dry']);
if (!o.dry) requireEnv();
const cap = Number(o.cap || cfg.cap), stagger = Number(o['stagger-ms'] ?? cfg.staggerMs);
const only = o.only ? new Set(o.only.split(',').filter(Boolean)) : null;
const onlyWorkers = o.workers ? new Set(o.workers.split(',')) : null;
const idKey = id => String(id).split(/[.-]/).map(x => (/^\d+$/.test(x) ? x.padStart(6, '0') : x)).join('.');
const jobs = fs.existsSync(P.jobs) ? fs.readdirSync(P.jobs).filter(f => f.endsWith('.json')).map(f => ({file: path.join(P.jobs, f), ...load(path.join(P.jobs, f))})) : [];
const ledger = id => (fs.existsSync(ledgerPath(id)) ? load(ledgerPath(id)) : null);
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const isDone = id => ['done', 'review'].includes(ledger(id)?.state);

// Stale claims: a worker whose runner is gone is free again; a ledger whose runner is gone failed.
for (const w of poolWorkers()) if (w.job && !alive(w.pid)) updateWorker(w.file, {job: null, pid: null});
for (const j of jobs) { const l = ledger(j.id); if (l && !l.finishedAt && !alive(l.pid)) save(ledgerPath(j.id), {...l, state: 'failed', error: 'runner died', finishedAt: now()}); }

const queue = [], skipped = {};
const skip = (id, why) => (skipped[why] ??= []).push(id);
for (const j of jobs.sort((a, b) => (a.wave ?? 99) - (b.wave ?? 99) || idKey(a.id).localeCompare(idKey(b.id)))) {
  if (only && !only.has(j.id)) continue;
  if (o.kind && j.kind !== o.kind) { skip(j.id, 'kind'); continue; }
  if (fs.existsSync(failedPath(j.id))) { skip(j.id, 'failed'); continue; }
  const l = ledger(j.id);
  if (l && !l.finishedAt) { skip(j.id, 'running'); continue; }
  if (l && ['done', 'review'].includes(l.state)) { skip(j.id, l.state); continue; }
  queue.push({...j, avoid: l?.worker || null});
}
const free = () => poolWorkers().filter(w => w.state === 'ready' && !w.job && (!onlyWorkers || onlyWorkers.has(w.name)));
console.log(JSON.stringify({cap, staggerMs: stagger, idleWorkers: free().length, queued: queue.map(j => ({id: j.id, kind: j.kind, wave: j.wave, after: j.after || [], retry: !!j.avoid})), skipped}));
if (o.dry) process.exit(0);

// Build each base bundle here, once, before any runner starts (runners racing on one bundle was the Paxeer fleet's round-1 loss).
for (const b of new Set(queue.map(j => git(repoRoot, 'rev-parse', '--verify', `${j.base}^{commit}`)))) baseBundle(b);

const running = new Map(); let pausedUntil = 0, backoff = cfg.backoff.initialMs; const settled = [];
let wake = null; const nudge = () => { if (wake) { wake(); wake = null; } };
function start(job, worker) {
  fs.mkdirSync(P.logs, {recursive: true, mode: 0o700});
  const log = fs.openSync(path.join(P.logs, `${safe(job.id)}.dispatch.log`), 'a', 0o600);
  updateWorker(worker.file, {job: job.id, jobStartedAt: now()});
  const child = spawn(process.execPath, [path.join(here, 'run-job.mjs'), worker.file, job.file], {stdio: ['ignore', log, log], env: process.env});
  updateWorker(worker.file, {pid: child.pid});
  running.set(job.id, {job, worker: worker.name, pid: child.pid});
  console.log(JSON.stringify({start: job.id, worker: worker.name, pid: child.pid, attempt: job.avoid ? 2 : 1}));
  child.on('exit', code => {
    running.delete(job.id); fs.closeSync(log);
    // the runner releases its worker; make sure even a crashed runner does
    const wf = path.join(P.ledger, 'pool', `${worker.name}.json`); if (fs.existsSync(wf) && load(wf).job === job.id) updateWorker(wf, {job: null, pid: null});
    const l = ledger(job.id) || {state: 'failed', error: `runner exit ${code} before its ledger`};
    if (['done', 'review'].includes(l.state)) { settled.push({id: job.id, state: l.state}); console.log(JSON.stringify({settled: job.id, state: l.state, worker: worker.name})); }
    else if (!job.avoid) {
      if (l.rateLimited) { pausedUntil = Date.now() + backoff; console.log(JSON.stringify({backoff: backoff / 1000, after: job.id})); backoff = Math.min(backoff * 2, cfg.backoff.maxMs); }
      queue.unshift({...job, avoid: worker.name}); console.log(JSON.stringify({retry: job.id, failedOn: worker.name, error: String(l.error || '').slice(0, 200)}));
    } else {
      if (fs.existsSync(ledgerPath(job.id))) { save(failedPath(job.id), {...l, finishedAt: l.finishedAt || now()}); fs.rmSync(ledgerPath(job.id)); }
      settled.push({id: job.id, state: 'failed'}); console.log(JSON.stringify({settled: job.id, state: 'failed', error: String(l.error || '').slice(0, 200)}));
    }
    nudge();
  });
}

while (queue.length || running.size) {
  if (Date.now() >= pausedUntil) {
    for (const job of [...queue]) {
      if (running.size >= cap) break;
      const after = job.after || [];
      if (after.some(a => fs.existsSync(failedPath(a)) || (!isDone(a) && !running.has(a) && !queue.some(q => q.id === a)))) {
        queue.splice(queue.indexOf(job), 1); settled.push({id: job.id, state: 'blocked'});
        console.log(JSON.stringify({settled: job.id, state: 'blocked', after})); continue;
      }
      if (!after.every(isDone)) continue;
      const w = free().find(w => w.name !== job.avoid);
      if (!w) continue;
      queue.splice(queue.indexOf(job), 1); start(job, w);
      if (stagger) await sleep(stagger);
    }
  }
  if (!running.size && queue.length) {
    if (Date.now() < pausedUntil) { await sleep(Math.min(5000, pausedUntil - Date.now())); continue; }
    const idle = free();
    if (!idle.length || queue.every(j => idle.every(w => w.name === j.avoid))) {
      for (const j of queue) settled.push({id: j.id, state: 'no-worker'});
      console.log(JSON.stringify({stalled: queue.map(j => j.id), reason: 'no free worker other than the failed attempt\'s'})); break;
    }
    continue;
  }
  await new Promise(r => { wake = r; setTimeout(r, 5000); });
}
const count = {}; for (const s of settled) count[s.state] = (count[s.state] || 0) + 1;
save(path.join(P.ledger, `dispatch-${Date.now()}.json`), {at: now(), cap, staggerMs: stagger, settled});
console.log(JSON.stringify({dispatched: settled.length, ...count}));
