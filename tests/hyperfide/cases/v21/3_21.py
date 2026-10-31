#!/usr/bin/env python3
"""hyperfide-v21 3.21: an IP-literal host is never a materialisation source.

GitHub can be reached by address, so a source named by an IP literal cannot be shown not to be GitHub; isGitHubHost refuses
IPv4 (every inet_aton spelling, which ssh: URLs keep as written), IPv6 and IPv4-mapped IPv6. Named hosts, including ones
that merely start with digits, still pass. The service source is compiled into a temporary tree so the probe runs the
real module, never a stale checkout dist."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
FAILED = []
PROBE = r"""
import fs from 'node:fs';
const dist=process.argv[1],i=JSON.parse(fs.readFileSync(0,'utf8'));
const store=await import(dist+'/preparation/object_store.js');
const out=[];
for(const u of i.urls){
 try{store.sourceURL(u);out.push({url:u,ok:true});}
 catch(e){out.push({url:u,error:e.code??e.message,message:e.message});}
}
for(const h of i.hosts)out.push({host:h,github:store.isGitHubHost(h)});
process.stdout.write(JSON.stringify(out));
"""

REFUSED = [
    'https://140.82.112.3/org/repo.git',
    'https://140.82.112.3./org/repo.git',
    'ssh://140.82.112.3/srv/repo.git',
    'ssh://2358111235/srv/repo.git',
    'ssh://0x8c.0x52.0x70.0x3/srv/repo.git',
    'ssh://0214.0122.0160.03/srv/repo.git',
    'ssh://140.5402.3/srv/repo.git',
    'https://0x8c527003/org/repo.git',
    'https://[2606:50c0:8000::153]/org/repo.git',
    'ssh://[2606:50c0:8000::153]/srv/repo.git',
    'https://[::ffff:140.82.112.3]/org/repo.git',
    'ssh://[::ffff:8c52:7003]/srv/repo.git',
    'https://[::1]/org/repo.git',
    'https://github.com/org/repo.git',
]
ACCEPTED = [
    'ssh://objects-usw2.railway.internal/srv/repo.git',
    'https://store.example.net/org/repo.git',
    'ssh://10x.example.net/srv/repo.git',
    'ssh://1.example.net/srv/repo.git',
    'file:///srv/store/repo.git',
]


def expect(value, message):
    if not value:
        raise AssertionError(message)


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)[:1500]
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


def build(base):
    service = base / 'core/control-plane'
    service.mkdir(parents=True)
    for name in ['package.json', 'tsconfig.json']:
        shutil.copyfile(SERVICE / name, service / name)
    shutil.copytree(SERVICE / 'src', service / 'src')
    (service / 'node_modules').symlink_to((SERVICE / 'node_modules').resolve(), target_is_directory=True)
    r = subprocess.run([str(service / 'node_modules/.bin/tsc'), '-p', 'tsconfig.json'], cwd=service, capture_output=True, text=True, timeout=900)
    expect(r.returncode == 0, 'build failed: ' + r.stdout[-2000:] + r.stderr[-2000:])
    return service / 'dist'


def main():
    if shutil.which('node') is None:
        print('SKIP: node is required')
        return 77
    if not (SERVICE / 'node_modules/.bin/tsc').exists():
        print('SKIP: core/control-plane/node_modules is not installed')
        return 77
    with tempfile.TemporaryDirectory(prefix='hf-v21-3-21-') as tmp:
        dist = build(Path(tmp))
        r = subprocess.run(['node', '--input-type=module', '-e', PROBE, str(dist)],
                           input=json.dumps({'urls': REFUSED + ACCEPTED,
                                             'hosts': ['140.82.112.3', '[::ffff:8c52:7003]', '2606:50c0:8000::153', 'GitHub.com.',
                                                       'store.example.net', '']}),
                           capture_output=True, text=True, timeout=120, env=dict(os.environ))
        expect(r.returncode == 0 and r.stdout, ('probe', r.stdout, r.stderr))
        got = json.loads(r.stdout)
        by_url = {g['url']: g for g in got if 'url' in g}
        by_host = {g['host']: g['github'] for g in got if 'host' in g}

        def refused():
            for u in REFUSED:
                expect(by_url[u].get('error') == 'SLICE_SOURCE_GITHUB_REFUSED', (u, by_url[u]))
            for u in REFUSED[:-1]:
                expect('IP-literal' in by_url[u]['message'], (u, by_url[u]))
        check('ip-literal.refused', refused)

        def accepted():
            for u in ACCEPTED:
                expect(by_url[u].get('ok') is True, (u, by_url[u]))
        check('named-host.accepted', accepted)

        def hosts():
            expect(by_host == {'140.82.112.3': True, '[::ffff:8c52:7003]': True, '2606:50c0:8000::153': True, 'GitHub.com.': True,
                               'store.example.net': False, '': False}, by_host)
        check('isGitHubHost.forms', hosts)
    print(json.dumps({'type': 'summary', 'failed': FAILED}))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
