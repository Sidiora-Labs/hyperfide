#!/usr/bin/env python3
"""hyperfide-v21 2.11: the internal object store and its per-region mirrors.

Local bare repositories stand in for the store and the mirrors; nothing reaches the network. The service source is
compiled into a temporary tree laid out like the checkout, so the assertions run the real modules and the real
bootstrap-host.mjs against that build, never a stale checkout dist."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
FAILED = []
GIT_ENV = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/nonexistent', 'LC_ALL': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@invalid',
           'GIT_COMMITTER_NAME': 'fixture', 'GIT_COMMITTER_EMAIL': 'fixture@invalid'}
# One node process per probe: the action is chosen by op and its inputs come on stdin.
PROBE = r"""
import fs from 'node:fs';
const dist=process.argv[1],i=JSON.parse(fs.readFileSync(0,'utf8'));
const store=await import(dist+'/preparation/object_store.js');
const out=v=>process.stdout.write(JSON.stringify(v));
try{
 if(i.op==='resolve')out({ok:store.resolveSource(store.parseObjectStore(i.config),i.repository,i.provider,i.region)});
 else if(i.op==='parse')out({ok:store.parseObjectStore(i.config)});
 else if(i.op==='freshness')out({ok:await store.mirrorFreshness(store.parseObjectStore(i.config),i.repository,20000)});
 else if(i.op==='railway'){
  const r=await import(dist+'/providers/railway/preparation.js');
  const client=new r.RailwayClient(i.client,{HF_RAILWAY_FIXTURE_TOKEN:'fixture'});
  out({ok:r.railwayMaterialisationSource(client,{HF_SLICE_SOURCE_CONFIG:i.file},i.repository),
   describe:r.createComponent({}).actions['railway.preparation.describe']({},{})});
 }
}catch(e){out({error:e.code??e.message});}
"""


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


def git(*args, cwd=None):
    r = subprocess.run(['git', *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True, timeout=120)
    expect(r.returncode == 0, ('git', args, r.stderr))
    return r.stdout.strip()


def commit(work, name, text):
    (work / name).write_text(text)
    git('add', name, cwd=work)
    git('commit', '-q', '-m', name, cwd=work)
    git('push', '-q', 'origin', 'HEAD:refs/heads/main', cwd=work)
    return git('rev-parse', 'HEAD', cwd=work)


def build(base):
    """Compile the checkout source into base/services/hyperfide/dist and place bootstrap-host.mjs beside it."""
    service = base / 'services/hyperfide'
    service.mkdir(parents=True)
    for name in ['package.json', 'tsconfig.json']:
        shutil.copyfile(SERVICE / name, service / name)
    shutil.copytree(SERVICE / 'src', service / 'src')
    (service / 'node_modules').symlink_to((SERVICE / 'node_modules').resolve(), target_is_directory=True)
    r = subprocess.run([str(service / 'node_modules/.bin/tsc'), '-p', 'tsconfig.json'], cwd=service, capture_output=True, text=True, timeout=900)
    expect(r.returncode == 0, 'build failed: ' + r.stdout[-2000:] + r.stderr[-2000:])
    (base / 'deploy/hyperfide').mkdir(parents=True)
    shutil.copyfile(ROOT / 'deploy/hyperfide/bootstrap-host.mjs', base / 'deploy/hyperfide/bootstrap-host.mjs')
    return service / 'dist'


def main():
    if shutil.which('node') is None or shutil.which('git') is None:
        print('SKIP: node and git are required')
        return 77
    if not (SERVICE / 'node_modules/.bin/tsc').exists():
        print('SKIP: services/hyperfide/node_modules is not installed')
        return 77
    with tempfile.TemporaryDirectory(prefix='hf-v21-2-11-') as tmp:
        base = Path(tmp)
        dist = build(base)
        bootstrap = base / 'deploy/hyperfide/bootstrap-host.mjs'

        def probe(payload):
            r = subprocess.run(['node', '--input-type=module', '-e', PROBE, str(dist)], input=json.dumps(payload), capture_output=True,
                               text=True, timeout=120)
            expect(r.returncode == 0 and r.stdout, ('probe', r.stdout, r.stderr))
            return json.loads(r.stdout)

        # The store, two Railway regional mirrors (one later left stale) and one mirror that does not exist.
        stores = base / 'stores'
        store, usw, eu = stores / 'store.git', stores / 'mirror-us-west2.git', stores / 'mirror-europe-west4.git'
        git('init', '-q', '--bare', '-b', 'main', str(store))
        work = base / 'work'
        git('clone', '-q', str(store), str(work))
        first = commit(work, 'a.txt', 'one\n')
        for mirror in [usw, eu]:
            git('clone', '-q', '--mirror', str(store), str(mirror))
        for repo in [store, usw, eu]:
            git('config', 'uploadpack.allowFilter', 'true', cwd=repo)
            git('config', 'uploadpack.allowAnySHA1InWant', 'true', cwd=repo)
        second = commit(work, 'b.txt', 'two\n')
        git('fetch', '-q', '--prune', 'origin', cwd=usw)
        url = lambda p: 'file://' + str(p)
        mirrors = {'railway': {'us-west2': url(usw), 'europe-west4': url(eu), 'asia-southeast1': url(stores / 'absent.git')}}
        config = {'schema_version': 2, 'missing_region': 'STORE',
                  'repositories': {'repo-1': {'store': url(store), 'mirrors': mirrors, 'submodules': {
                      'vendor/lib': {'store': url(store), 'mirrors': {'railway': {'us-west2': url(usw)}}}}}}}
        config_file = base / 'object-store.json'
        config_file.write_text(json.dumps(config))

        def resolve(provider, region, cfg=config):
            return probe({'op': 'resolve', 'config': cfg, 'repository': 'repo-1', 'provider': provider, 'region': region})

        def region_mirror():
            for region, path in [('us-west2', usw), ('europe-west4', eu)]:
                r = resolve('railway', region)['ok']
                expect(r['url'] == url(path) and r['resolution'] == 'MIRROR' and r['store'] == url(store) and r['region'] == region, r)
            sub = resolve('railway', 'us-west2')['ok']['submodules']['vendor/lib']
            expect(sub['url'] == url(usw) and sub['resolution'] == 'MIRROR', sub)
        check('resolve.region-mirror', region_mirror)

        def provider_scoped():
            r = resolve('blaxel', 'us-west2')['ok']
            expect(r['resolution'] == 'STORE' and r['url'] == url(store), r)
        check('resolve.mirror-is-provider-scoped', provider_scoped)

        def missing_region_store():
            r = resolve('railway', 'us-east4')['ok']
            expect(r['resolution'] == 'STORE' and r['url'] == url(store), r)
        check('resolve.missing-region-uses-store', missing_region_store)

        def missing_region_refused():
            r = resolve('railway', 'us-east4', dict(config, missing_region='REFUSE'))
            expect(r.get('error') == 'SLICE_SOURCE_NO_REGIONAL_MIRROR', r)
            expect(resolve('railway', 'us-west2', dict(config, missing_region='REFUSE'))['ok']['resolution'] == 'MIRROR', 'refusal leaked to a mirrored region')
            r = probe({'op': 'parse', 'config': {k: v for k, v in config.items() if k != 'missing_region'}})
            expect(r.get('error') == 'SLICE_SOURCE_UNAVAILABLE', ('missing_region has no default', r))
        check('resolve.missing-region-refused-when-configured', missing_region_refused)

        def unknown_repository():
            r = probe({'op': 'resolve', 'config': config, 'repository': 'other', 'provider': 'railway', 'region': 'us-west2'})
            expect(r.get('error') == 'SLICE_SOURCE_UNAVAILABLE', r)
        check('resolve.unknown-repository-refused', unknown_repository)

        def github_refused():
            hub = ['https://github.com/org/repo.git', 'ssh://github.com/org/repo.git', 'https://GitHub.com./org/repo.git',
                   'https://codeload.github.com/org/repo', 'https://raw.githubusercontent.com/org/repo/main']
            places = [lambda u: {'store': u}, lambda u: {'mirrors': {'railway': {'us-west2': u}}},
                      lambda u: {'submodules': {'vendor/lib': {'store': u, 'mirrors': {}}}}]
            for u in hub:
                for place in places:
                    entry = dict(config['repositories']['repo-1'], **place(u))
                    r = probe({'op': 'parse', 'config': dict(config, repositories={'repo-1': entry})})
                    expect(r.get('error') == 'SLICE_SOURCE_GITHUB_REFUSED', (u, r))
                r = probe({'op': 'parse', 'config': {'schema_version': 1, 'repositories': {'repo-1': {'url': u, 'submodules': {}}}}})
                expect(r.get('error') == 'SLICE_SOURCE_GITHUB_REFUSED', ('schema 1', u, r))
            # Positive control: the same shapes on internal hosts are accepted.
            ok = dict(config['repositories']['repo-1'], store='https://git.objects.internal/repo.git',
                      mirrors={'railway': {'us-west2': 'ssh://objects-usw2.railway.internal/srv/repo.git'}})
            r = probe({'op': 'parse', 'config': dict(config, repositories={'repo-1': ok})})
            expect('ok' in r, r)
            r = probe({'op': 'parse', 'config': dict(config, repositories={'repo-1': dict(ok, store='https://notgithub.com/repo.git')})})
            expect('ok' in r, ('a lookalike host is not GitHub', r))
        check('source.github-refused', github_refused)

        def schema_one_compatible():
            r = probe({'op': 'resolve', 'config': {'schema_version': 1, 'repositories': {'repo-1': {'url': url(store), 'submodules': {}}}},
                       'repository': 'repo-1', 'provider': 'railway', 'region': 'us-west2'})['ok']
            expect(r['resolution'] == 'STORE' and r['url'] == url(store), r)
        check('source.schema-1-is-store-without-mirrors', schema_one_compatible)

        def partial_clone_from_mirror():
            r = resolve('railway', 'us-west2')['ok']
            target = base / 'clone-usw'
            git('clone', '-q', '--no-checkout', '--filter=blob:none', '--sparse', '--', r['url'], str(target))
            expect(git('rev-parse', 'origin/main', cwd=target) == second, 'fresh mirror lacks the store head')
            missing = [l for l in git('rev-list', '--objects', '--missing=print', second, cwd=target).split('\n') if l.startswith('?')]
            expect(missing, 'mirror ignored the blob filter; the slice cost could not be claimed')
        check('materialise.partial-clone-from-region-mirror', partial_clone_from_mirror)

        def freshness():
            r = probe({'op': 'freshness', 'config': config, 'repository': 'repo-1'})['ok']
            by = {m['region']: m for m in r['mirrors']}
            expect(by['us-west2']['state'] == 'FRESH' and not by['us-west2']['behind'], by['us-west2'])
            expect(by['europe-west4']['state'] == 'STALE' and by['europe-west4']['behind'] == ['refs/heads/main'], by['europe-west4'])
            expect(by['asia-southeast1']['state'] == 'UNREACHABLE', by['asia-southeast1'])
            expect(git('rev-parse', 'refs/heads/main', cwd=eu) == first, 'stale mirror moved')
        check('freshness.fresh-stale-unreachable', freshness)

        def freshness_extra_ref():
            git('update-ref', 'refs/heads/deleted', first, cwd=usw)
            try:
                r = probe({'op': 'freshness', 'config': config, 'repository': 'repo-1'})['ok']
                m = [m for m in r['mirrors'] if m['region'] == 'us-west2'][0]
                expect(m['state'] == 'STALE' and m['extra'] == ['refs/heads/deleted'] and not m['behind'], m)
            finally:
                git('update-ref', '-d', 'refs/heads/deleted', cwd=usw)
        check('freshness.extra-ref-is-stale', freshness_extra_ref)

        def store_unreachable():
            cfg = json.loads(json.dumps(config))
            cfg['repositories']['repo-1']['store'] = url(stores / 'no-store.git')
            r = probe({'op': 'freshness', 'config': cfg, 'repository': 'repo-1'})
            expect(r.get('error') == 'SLICE_SOURCE_STORE_UNREACHABLE', r)
        check('freshness.store-unreachable-refused', store_unreachable)

        def cli(args, env_extra, code):
            env = dict(GIT_ENV, **env_extra)
            r = subprocess.run(['node', str(bootstrap), *args], env=env, capture_output=True, text=True, timeout=120)
            expect(r.returncode == code, (r.returncode, r.stdout, r.stderr))
            return json.loads(r.stdout)

        def bootstrap_freshness():
            r = cli(['--object-store-freshness', 'repo-1'], {'HF_SLICE_SOURCE_CONFIG': str(config_file)}, 1)
            expect(r['outcome'] == 'STALE' and r['services_started'] is False, r)
            git('fetch', '-q', '--prune', 'origin', cwd=eu)
            fresh = dict(config, repositories={'repo-1': dict(config['repositories']['repo-1'],
                         mirrors={'railway': {'us-west2': url(usw), 'europe-west4': url(eu)}})})
            fresh_file = base / 'fresh.json'
            fresh_file.write_text(json.dumps(fresh))
            r = cli(['--object-store-freshness', 'repo-1'], {'HF_SLICE_SOURCE_CONFIG': str(fresh_file)}, 0)
            expect(r['outcome'] == 'FRESH' and all(m['state'] == 'FRESH' for m in r['mirrors']) and len(r['mirrors']) == 2, r)
        check('bootstrap.freshness-report', bootstrap_freshness)

        def bootstrap_github_refused():
            bad = base / 'github.json'
            bad.write_text(json.dumps(dict(config, repositories={'repo-1': dict(config['repositories']['repo-1'], store='https://github.com/org/repo.git')})))
            r = cli(['--object-store-freshness', 'repo-1'], {'HF_SLICE_SOURCE_CONFIG': str(bad)}, 78)
            expect(r['outcome'] == 'REFUSED' and r['error']['code'] == 'SLICE_SOURCE_GITHUB_REFUSED', r)
        check('bootstrap.github-config-refused', bootstrap_github_refused)

        def railway_source():
            client = {'schema_version': 1, 'mode': 'component-fixture', 'endpoint': 'http://127.0.0.1:9/graphql', 'environment_id': 'env-1',
                      'region': 'us-west2', 'account_id': 'acct-1', 'token_env': 'HF_RAILWAY_FIXTURE_TOKEN', 'auth_type': 'bearer',
                      'preparation_root': str(base / 'prep'), 'request_timeout_ms': 1000, 'exec_ws_endpoint': None}
            r = probe({'op': 'railway', 'client': client, 'file': str(config_file), 'repository': 'repo-1'})
            expect(r['ok']['url'] == url(usw) and r['ok']['resolution'] == 'MIRROR', r)
            expect(r['describe']['source'] == 'OBJECT_STORE_REGION_MIRROR' and r['describe']['clone'] == 'DISK_ONLY', r['describe'])
            r = probe({'op': 'railway', 'client': dict(client, region='europe-west4'), 'file': str(config_file), 'repository': 'repo-1'})
            expect(r['ok']['url'] == url(eu), r)
            live = dict(client, mode='live', endpoint='https://backboard.railway.com/graphql/v2')
            r = probe({'op': 'railway', 'client': live, 'file': str(config_file), 'repository': 'repo-1'})
            expect(r.get('error') == 'Railway object store mirror is not on the private network', r)
            private = base / 'private.json'
            private.write_text(json.dumps(dict(config, repositories={'repo-1': dict(config['repositories']['repo-1'],
                               mirrors={'railway': {'us-west2': 'ssh://objects-usw2.railway.internal/srv/repo.git'}})})))
            r = probe({'op': 'railway', 'client': live, 'file': str(private), 'repository': 'repo-1'})
            expect(r['ok']['url'] == 'ssh://objects-usw2.railway.internal/srv/repo.git', r)
        check('railway.nearest-mirror-and-private-network', railway_source)

        def no_network_sources():
            text = config_file.read_text()
            expect('github' not in text and 'http' not in text, 'the fixture configuration names a network source')
        check('fixture.no-network', no_network_sources)
    print(json.dumps({'type': 'summary', 'failed': FAILED}))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
