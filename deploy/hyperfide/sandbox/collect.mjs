// Land one settled job locally: its bundle becomes branch sandbox/<id> in the main repository's object store (fetched, never
// checked out, main untouched), its evidence archive unpacks under state/evidence/<id>/ (the supervisor moves it into the
// gitignored data dirs), READY.txt or NOT-QUALIFIED.txt records the verdict and state/ledger/<id>.txt the one-line summary.
// usage: node collect.mjs <job-id> [--force]   (--force re-collects a job already collected)
import {P, load, save, now, safe, git, tryGit, repoRoot, findLedger, opts} from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';

const o = opts(process.argv.slice(2), ['force']);
const id = o._[0]; if (!id) throw new Error('usage: collect.mjs <job-id> [--force]');
const L = findLedger(id); if (!L) throw new Error(`no ledger for job ${id}`);
const rec = load(L);
if (!rec.finishedAt) throw new Error(`job ${id} is still running`);
if (rec.collected && !o.force) { console.log(JSON.stringify({id, already: rec.collected.verdict})); process.exit(0); }
const S = safe(id), out = path.join(P.evidence, S), branch = `sandbox/${id}`;
fs.rmSync(out, {recursive: true, force: true}); fs.mkdirSync(out, {recursive: true, mode: 0o700});
const reasons = [];
let tip = null, files = [];
if (rec.bundle && fs.existsSync(rec.bundle)) {
  try {
    git(repoRoot, 'bundle', 'verify', '-q', rec.bundle);
    git(repoRoot, 'fetch', '-q', rec.bundle, `+refs/heads/${rec.branch}:refs/heads/${branch}`);
    tip = git(repoRoot, 'rev-parse', `refs/heads/${branch}`);
    files = git(repoRoot, 'diff', '--name-only', rec.baseCommit, tip).split('\n').filter(Boolean);
  } catch (e) { reasons.push(`bundle did not land: ${String(e.stderr || e.message).trim().slice(0, 300)}`); }
} else if (rec.kind === 'codex' || rec.commits) reasons.push('no bundle');
if (rec.evidence && fs.existsSync(rec.evidence)) {
  try { execFileSync('tar', ['xzf', rec.evidence, '-C', out, '--no-same-owner', '--no-same-permissions'], {stdio: ['ignore', 'pipe', 'pipe']}); }
  catch (e) { reasons.push(`evidence did not unpack: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
}
for (const f of [rec.log, rec.specPatch]) if (f && fs.existsSync(f)) fs.copyFileSync(f, path.join(out, path.basename(f)));
if (rec.state !== 'done') reasons.unshift(rec.state === 'review' ? 'review: the agent exited cleanly without a commit' : `failed: ${String(rec.error || 'unknown').slice(0, 300)}`);
if (rec.kind === 'qualify' && rec.jobExit !== 0 && rec.state === 'done') reasons.push(`qualify exit ${rec.jobExit}`);
const ask = files.includes('ASK.md');
if (ask) reasons.push('the agent wrote ASK.md: answer it before merging');
const ready = !reasons.length;
const verdict = ready ? 'READY' : 'NOT-QUALIFIED';
const body = [`${verdict} ${id}`, `kind ${rec.kind} feature ${rec.feature} task ${rec.task} worker ${rec.worker} attempt ${rec.attempt}`,
  `base ${rec.baseCommit}`, `branch ${tip ? `${branch} ${tip}` : '-'}`, `commits ${rec.commits ?? 0} files ${files.length}`,
  ...(reasons.length ? ['reasons:', ...reasons.map(r => `- ${r}`)] : []), ...(files.length ? ['files:', ...files.map(f => `- ${f}`)] : [])].join('\n') + '\n';
for (const f of ['READY.txt', 'NOT-QUALIFIED.txt']) fs.rmSync(path.join(out, f), {force: true});
fs.writeFileSync(path.join(out, `${verdict}.txt`), body, {mode: 0o600});
const line = `${verdict} ${id} ${rec.kind} ${rec.feature}/${rec.task} ${tip ? `${branch}@${tip.slice(0, 12)}` : 'no-branch'} commits=${rec.commits ?? 0} files=${files.length} worker=${rec.worker}${reasons.length ? ` reason=${reasons[0].replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
fs.writeFileSync(path.join(P.ledger, `${S}.txt`), line + '\n', {mode: 0o600});
rec.collected = {at: now(), verdict, branch: tip ? branch : null, tip, files, ask, reasons}; save(L, rec);
console.log(line);
