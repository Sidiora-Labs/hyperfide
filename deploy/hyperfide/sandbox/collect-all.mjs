// Collect every settled, not yet collected job (done, review, and the failed/ ledgers), in wave then id order.
// usage: node collect-all.mjs [--states done,review,failed]
import {P, load, here, opts} from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';

const o = opts(process.argv.slice(2));
const states = (o.states || 'done,review,failed').split(',');
const recs = ['jobs', 'failed'].flatMap(d => { const dir = path.join(P.ledger, d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => load(path.join(dir, f))) : []; });
const waveOf = id => { const f = path.join(P.jobs, `${id}.json`); return fs.existsSync(f) ? (load(f).wave ?? 99) : 99; };
const ids = recs.filter(r => r.finishedAt && !r.collected && states.includes(r.state)).map(r => r.id)
  .sort((a, b) => waveOf(a) - waveOf(b) || a.localeCompare(b, undefined, {numeric: true}));
const out = {READY: [], 'NOT-QUALIFIED': [], errors: []};
for (const id of ids) {
  try {
    const line = execFileSync(process.execPath, [path.join(here, 'collect.mjs'), id], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env}).trim().split('\n').pop();
    console.log(line); (line.startsWith('READY') ? out.READY : out['NOT-QUALIFIED']).push(id);
  } catch (e) { out.errors.push({id, error: String(e.stderr || e.message).slice(-400)}); }
}
console.log(JSON.stringify({ready: out.READY.length, notQualified: out['NOT-QUALIFIED'].length, errors: out.errors}));
if (out.errors.length) process.exitCode = 1;
