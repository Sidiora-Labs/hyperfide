// Hyperfide sandbox provisioner (Railway sandboxes).
// usage: node provision.mjs base --from-checkpoint <name> [commit]  -> clone local main (as a git bundle, never GitHub) into a sandbox
//                                                                     booted from <name>, build cg and the service, checkpoint it as
//                                                                     hf-base-<commit10>, record checkpoint + commit in fleet.json
//        node provision.mjs use <checkpoint> <commit>               -> record a checkpoint built elsewhere in fleet.json
//        node provision.mjs pool [n]                                -> create n workers (default pool.defaultSize; total capped at pool.maxSize)
//        node provision.mjs list                                    -> sandboxes in the environment, with pool names where known
//        node provision.mjs destroy <sandboxId>                     -> destroy one sandbox by explicit id
//        node provision.mjs teardown [--force]                      -> destroy every pool worker (busy ones only with --force)
// A Railway sandbox carries no name: a pool name is the state/ledger/pool/<name>.json record that owns the sandbox id.
import {cfg, P, W, sdk, requireEnv, save, now, run, must, redact, git, repoRoot, mainTip, isAncestor, poolWorkers, fill, sleep, opts,
  recordCheckpoint} from './lib.mjs';
import path from 'node:path'; import fs from 'node:fs'; import {randomUUID} from 'node:crypto';

const o = opts(process.argv.slice(2), ['force']);
const [mode, ...args] = o._;
if (mode === 'use') {
  const [name, commit] = args;
  if (!name || !/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('usage: provision.mjs use <checkpoint> <full commit sha>');
  recordCheckpoint(name, commit); console.log(JSON.stringify({checkpoint: name, checkpointCommit: commit}));
  process.exit(0);
}
requireEnv([cfg.env.token, cfg.env.environmentId]);
const {Sandbox, SandboxNotFoundError, config} = await sdk();
const create = {resources: cfg.resources, idleTimeoutMinutes: cfg.idleTimeoutMinutes};
const pool = cfg.pool;

if (mode === 'base') {
  const from = o['from-checkpoint'];
  if (!from) throw new Error('usage: provision.mjs base --from-checkpoint <name> [commit]');
  const commit = git(repoRoot, 'rev-parse', '--verify', `${args[0] || cfg.mainBranch}^{commit}`);
  if (!isAncestor(commit, mainTip())) throw new Error(`${commit} is not on local ${cfg.mainBranch}`);
  const name = cfg.checkpointPrefix + commit.slice(0, 10);
  const rec = {at: now(), state: 'creating', from, commit, checkpoint: name, steps: []};
  const recFile = path.join(P.ledger, `base-${commit.slice(0, 10)}.json`); save(recFile, rec);
  const bundle = path.join(P.bundles, `main-${commit.slice(0, 12)}.bundle`);
  if (!fs.existsSync(bundle)) {
    fs.mkdirSync(P.bundles, {recursive: true, mode: 0o700}); const tmp = `${bundle}.${randomUUID()}.tmp`;
    git(repoRoot, 'bundle', 'create', '-q', tmp, `refs/heads/${cfg.mainBranch}`); fs.renameSync(tmp, bundle);
  }
  const t0 = Date.now(); const sb = await Sandbox.create(from, {...config, ...create});
  rec.sandboxId = sb.id; rec.steps.push({label: 'create', ms: Date.now() - t0}); save(recFile, rec);
  console.log('base sandbox', sb.id, 'from', from, 'commit', commit);
  try {
    const t1 = Date.now();
    await must(sb, 'mkdir -p /work/in /work/out /work/logs /work/packets /work/evidence', {timeoutSec: 60, label: 'dirs'});
    await sb.files.write('/work/in/main.bundle', fs.readFileSync(bundle), {mode: 0o600});
    rec.steps.push({label: 'upload', ms: Date.now() - t1, bytes: fs.statSync(bundle).size}); save(recFile, rec);
    for (const [label, cmd, timeoutSec] of cfg.base.steps) {
      const r = await must(sb, fill(cmd, {W, commit}), {timeoutSec, label});
      rec.steps.push({label, exit: r.exitCode, ms: r.ms, tail: r.stdout.slice(-400)}); save(recFile, rec);
      console.log(`[${Math.round(r.ms / 1000)}s] ${label} ok`);
    }
    const t2 = Date.now(); rec.checkpointInfo = await sb.checkpoint(name);
    rec.steps.push({label: 'checkpoint', ms: Date.now() - t2}); rec.state = 'checkpointed';
    recordCheckpoint(name, commit);
    console.log('checkpoint', name, 'commit', commit, '(recorded in fleet.json)');
  } catch (e) { rec.state = 'failed'; rec.error = redact(e.message).slice(0, 3000); process.exitCode = 1; console.error(rec.error); }
  finally { rec.endedAt = now(); save(recFile, rec); try { await sb.destroy(); console.log('base sandbox destroyed'); } catch (e) { console.error('destroy failed', redact(e.message)); } }

} else if (mode === 'pool') {
  const count = Number(args[0] || pool.defaultSize);
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  if (!cfg.checkpoint) throw new Error('fleet.json has no checkpoint: run `provision.mjs base` or `provision.mjs use` first');
  const all = poolWorkers(), live = all.filter(w => w.state !== 'destroyed');
  if (live.length + count > pool.maxSize) throw new Error(`pool would hold ${live.length + count} workers; the cap is ${pool.maxSize}`);
  const used = new Set(live.map(w => w.name)); const todo = [];
  for (let n = 1; todo.length < count; n++) { const name = `${pool.prefix}${String(n).padStart(3, '0')}`; if (!used.has(name)) todo.push(name); }
  const results = [], pending = [];
  for (const [i, name] of todo.entries()) {
    if (i) await sleep(cfg.staggerMs);
    pending.push((async () => {
      try {
        const t0 = Date.now();
        // No credential enters the sandbox environment; each job hands its gateway key over in a root-only file.
        const sb = await Sandbox.create(cfg.checkpoint, {...config, ...create, env: {FLEET_WORKER: name}});
        const probe = await run(sb, fill(cfg.probe, {W}), {timeoutSec: 180, label: 'probe'});
        const rec = {name, sandboxId: sb.id, createdAt: now(), bootMs: Date.now() - t0, checkpoint: cfg.checkpoint, resources: cfg.resources,
          state: probe.exitCode === 0 ? 'ready' : 'probe_failed', probe: probe.stdout.trim().split('\n'), probeErr: probe.stderr.slice(-500), job: null};
        save(path.join(P.ledger, 'pool', `${name}.json`), rec); results.push(rec);
        console.log(JSON.stringify({worker: name, state: rec.state, bootMs: rec.bootMs}));
      } catch (e) { results.push({name, error: true}); console.error('worker', name, 'failed:', redact(e.message).slice(0, 300)); }
    })());
  }
  await Promise.all(pending);
  const ready = results.filter(r => r.state === 'ready').length;
  console.log('ready', ready, 'of', count); if (ready < count) process.exitCode = 1;

} else if (mode === 'list') {
  const byId = new Map(poolWorkers().map(w => [w.sandboxId, w.name]));
  const list = await Sandbox.list({...config, first: 200});
  const c = {}; for (const s of list) c[s.status] = (c[s.status] || 0) + 1;
  console.log(list.length, JSON.stringify(c));
  for (const s of list) if (s.status !== 'DESTROYED') console.log(s.id, s.status, s.createdAt || '-', byId.get(s.id) || '-');

} else if (mode === 'destroy') {
  if (!args[0]) throw new Error('sandbox id required');
  const sb = await Sandbox.connect(args[0], config); await sb.destroy(); console.log('destroyed', args[0]);
  for (const w of poolWorkers()) if (w.sandboxId === args[0]) { const {file, ...rec} = w; save(file, {...rec, state: 'destroyed', destroyedAt: now()}); }

} else if (mode === 'teardown') {
  const targets = poolWorkers().filter(w => w.name?.startsWith(pool.prefix) && w.state !== 'destroyed');
  const busy = targets.filter(w => w.job);
  if (busy.length && !o.force) throw new Error(`busy workers ${busy.map(w => `${w.name}:${w.job}`).join(', ')}; rerun with --force to destroy them too`);
  let ok = 0;
  await Promise.all(targets.map(async w => {
    const {file, ...rec} = w;
    try { const sb = await Sandbox.connect(w.sandboxId, config); await sb.destroy(); ok++; }
    catch (e) { if (!(e instanceof SandboxNotFoundError)) { console.error(w.name, 'destroy failed:', redact(e.message).slice(0, 300)); return; } ok++; }
    save(file, {...rec, state: 'destroyed', destroyedAt: now()}); console.log('destroyed', w.name);
  }));
  console.log('teardown', ok, 'of', targets.length); if (ok < targets.length) process.exitCode = 1;

} else throw new Error('unknown mode: ' + mode + ' (base|use|pool|list|destroy|teardown)');
