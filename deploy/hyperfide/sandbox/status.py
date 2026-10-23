#!/usr/bin/env python3
"""Summarise the fleet: python3 status.py [--detail]
  pool workers by state with busy/idle counts, jobs as queued/running/done/review/failed, collected verdicts, and per worker
  the job it holds or last ran. --detail adds one line per job."""
import collections, glob, json, os, sys

here = os.path.dirname(os.path.abspath(__file__))
cfg_file = os.path.abspath(os.environ.get('HF_FLEET_CONFIG') or os.path.join(here, 'fleet.json'))
cfg = json.load(open(cfg_file))
paths = {k: os.path.normpath(os.path.join(os.path.dirname(cfg_file), v)) for k, v in cfg['paths'].items()}
L = paths['ledger']


def load(f):
    with open(f) as fh:
        return json.load(fh)


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (TypeError, ValueError, OSError):
        return False


pool = sorted((load(f) for f in glob.glob(os.path.join(L, 'pool', '*.json'))), key=lambda w: w['name'])
live = [w for w in pool if w.get('state') != 'destroyed']
print('pool:', dict(collections.Counter(w.get('state') for w in pool)),
      'busy:', sum(1 for w in live if w.get('job')), 'idle:', sum(1 for w in live if w.get('state') == 'ready' and not w.get('job')))
jobs = {os.path.basename(f)[:-5]: load(f) for f in glob.glob(os.path.join(paths['jobs'], '*.json'))}
led = {}
for sub in ('jobs', 'failed'):
    for f in glob.glob(os.path.join(L, sub, '*.json')):
        d = load(f)
        led[d['id']] = d if sub == 'jobs' else {**d, 'state': 'failed', 'final': True}


def state(jid):
    d = led.get(jid)
    if not d:
        return 'queued'
    if not d.get('finishedAt'):
        return 'running' if alive(d.get('pid')) or not d.get('pid') else 'failed'
    return d['state']


ids = sorted(set(jobs) | set(led), key=lambda i: [(0, int(x)) if x.isdigit() else (1, x) for x in i.replace('-', '.').split('.')])
counts = collections.Counter(state(i) for i in ids)
print('jobs:', ' '.join(f'{k}={counts.get(k, 0)}' for k in ('queued', 'running', 'done', 'review', 'failed')),
      'collected:', dict(collections.Counter((led[i].get('collected') or {}).get('verdict') for i in ids if i in led and led[i].get('collected'))))
for st in ('review', 'failed'):
    sel = [i for i in ids if state(i) == st]
    if sel:
        print(f'  {st}:', ' '.join(sel))
for w in live:
    print('  worker %-8s %-12s %s' % (w['name'], w.get('state'), f"job={w['job']}" if w.get('job') else f"last={w.get('lastJob') or '-'}:{w.get('lastState') or '-'}"))
if '--detail' in sys.argv:
    for i in ids:
        d = led.get(i) or {}
        print('  %-22s %-8s kind=%-7s attempt=%s worker=%-8s commits=%-3s %s..%s %s' % (
            i, state(i), (jobs.get(i) or d).get('kind'), d.get('attempt', '-'), d.get('worker', '-'), d.get('commits', '-'),
            (d.get('startedAt') or '')[11:19], (d.get('finishedAt') or '-')[11:19], (d.get('error') or '')[:80].replace('\n', ' ')))
