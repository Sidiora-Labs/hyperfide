#!/usr/bin/env python3
"""Build dispatch jobs (state/jobs/<id>.json) and Codex packets (state/packets/<id>.md) from the spec at the base commit.
usage: gen-jobs.py --requalify <feature> <task...> [--base REF] [--timeout-sec N]
       gen-jobs.py --v21 <task...> [--base REF] [--timeout-sec N]
  --requalify: one qualify job per task (id <feature>-<task>), wave order recorded; a task that requires an earlier task of the
               same request runs `after` it, from its result.
  --v21:       one codex job per hyperfide-v21 task (id v21-<task>) with a packet built from the task block.
  The spec is read from the local main repository at --base (default: local main), never from a working tree or GitHub."""
import argparse, json, os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
cfg_file = os.path.abspath(os.environ.get('HF_FLEET_CONFIG') or os.path.join(here, 'fleet.json'))
cfg = json.load(open(cfg_file))
cfg_dir = os.path.dirname(cfg_file)
paths = {k: os.path.normpath(os.path.join(cfg_dir, v)) for k, v in cfg['paths'].items()}


def git(*a, cwd=cfg_dir):
    return subprocess.run(['git', '-C', cwd, *a], check=True, capture_output=True, text=True).stdout.strip()


repo = os.path.normpath(os.path.join(cfg_dir, cfg['repo'])) if cfg.get('repo') else \
    os.path.dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'))

SECTION = re.compile(r'^\[([^\]\n]+)\]\n((?:(?!\[).*(?:\n|$))*)', re.M)
FIELD = re.compile(r'^([A-Za-z_0-9]+) = (.*)$', re.M)


def tasks_of(text):
    out = {}
    for m in SECTION.finditer(text):
        kind, _, ident = m.group(1).partition('.')
        if kind != 'task':
            continue
        fields = {}
        for k, v in FIELD.findall(m.group(2)):
            try:
                fields[k] = json.loads(v)
            except json.JSONDecodeError:
                fields[k] = v
        out[ident] = fields
    return out


def key(i):
    return [int(p) if p.isdigit() else p for p in re.split(r'[.-]', i)]


def write(path, text, mode=0o600):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + '.tmp'
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode), 'w') as f:
        f.write(text)
    os.replace(tmp, path)


RULES = """## Standing rules
- Implement only this task. Stay inside `touches` plus files you must create; name anything else in your final message.
- Verify for real: run the verify_cmd until it passes. Never weaken, stub or skip a test to make it pass. No false done.
- When it passes, set this task's `status` to "implemented" in spec/{feature}/spec.kvx. Never run `cg spec done` and never set
  "done": qualification reruns on main.
- Make exactly one plain git commit on the current branch whose message ends with `[spec:{feature}/{task}]`.
  No Co-Authored-By or any other trailer lines. Never push, never open a pull request, never touch CHANGELOG.md or CODEMAP.md, never read .env.
- When you need a variable, secret, permission, decision or answer you cannot derive from the code or the spec, do not pick a default:
  raise it with the codify MCP `ask_raise` tool (CG_TASK is set) and also write ASK.md at the repository root with: kind
  (secret|variable|permission|decision|question), the question in one sentence, the options with the one you recommend, what is
  blocked, and what you finished anyway. Finish everything that does not depend on the answer.
- Base commit: {{{{BASE_COMMIT}}}}. Repository: the current directory; the binary is ./cg (run `make cg` after C changes).
"""


def packet(feature, tid, t):
    lines = [f"# Task {feature}/{tid}: {t.get('title', '')}", '',
             f"You are the worker for task {tid} of spec/{feature}/spec.kvx in this repository.", '',
             '## Task', f"- requires: {', '.join(t.get('requires') or []) or 'none'}",
             f"- touches: {', '.join(t.get('touches') or []) or 'none listed'}",
             f"- verify_cmd: `{t.get('verify_cmd', '')}`"]
    for k in sorted((k for k in t if re.fullmatch(r'do_\d+', k)), key=lambda k: int(k[3:])):
        lines.append(f"- {k}: {t[k]}")
    return '\n'.join(lines) + '\n\n' + RULES.format(feature=feature, task=tid)


ap = argparse.ArgumentParser()
ap.add_argument('--requalify', nargs='+', metavar=('FEATURE', 'TASK'))
ap.add_argument('--v21', nargs='+', metavar='TASK')
ap.add_argument('--base', default=cfg['mainBranch'])
ap.add_argument('--timeout-sec', type=int)
a = ap.parse_args()
if bool(a.requalify) == bool(a.v21):
    ap.error('give exactly one of --requalify <feature> <task...> or --v21 <task...>')
if a.requalify and len(a.requalify) < 2:
    ap.error('--requalify needs a feature and at least one task')
base = git('rev-parse', '--verify', a.base + '^{commit}', cwd=repo)
feature, ids = (a.requalify[0], a.requalify[1:]) if a.requalify else ('hyperfide-v21', a.v21)
try:
    tasks = tasks_of(git('show', f'{base}:spec/{feature}/spec.kvx', cwd=repo))
except subprocess.CalledProcessError:
    sys.exit(f'no spec/{feature}/spec.kvx at {base[:12]}')
missing = [i for i in ids if i not in tasks]
if missing:
    sys.exit(f'unknown task(s) in spec/{feature}/spec.kvx at {base[:12]}: {" ".join(missing)}')

ordered = sorted(ids, key=lambda i: (tasks[i].get('wave', 99), key(i)))
written = []
for n, tid in enumerate(ordered):
    t = tasks[tid]
    if a.requalify:
        jid = f'{feature}-{tid}'
        earlier = ordered[:n]
        after = [f'{feature}-{r}' for r in earlier if r in (t.get('requires') or [])]
        # one predecessor chain: run after the latest required task of this request (it carries the earlier ones)
        job = {'id': jid, 'kind': 'qualify', 'feature': feature, 'task': tid, 'base': base, 'wave': t.get('wave'),
               'order': n + 1, 'after': after[-1:], 'timeoutSec': a.timeout_sec or cfg['qualify']['timeoutSec']}
    else:
        jid = f'v21-{tid}'
        pk = os.path.join(paths['packets'], f'{jid}.md')
        write(pk, packet(feature, tid, t))
        job = {'id': jid, 'kind': 'codex', 'feature': feature, 'task': tid, 'base': base, 'wave': t.get('wave'),
               'packet': pk, 'timeoutSec': a.timeout_sec or cfg['codex']['timeoutSec']}
    write(os.path.join(paths['jobs'], f'{jid}.json'), json.dumps(job, indent=2) + '\n')
    written.append(jid)
    print(json.dumps({'job': jid, 'kind': job['kind'], 'wave': job['wave'], 'after': job.get('after', [])}))
print(f'{len(written)} job(s) at base {base[:12]}')
