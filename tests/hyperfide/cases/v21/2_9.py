#!/usr/bin/env python3
"""hyperfide-v21 2.9: the supervisory host and the issue watcher deploy from shipped units and templates.
Both roles bootstrap into a temporary root; the release marker is staged by the built releases.ts exactly as
scripts/release.sh stages it, and the bootstrap preflight and the release inspector decide from that one marker.
Nothing here deploys to a real host or runs release.sh end to end."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / 'deploy/hyperfide'
SERVICE = ROOT / 'core/control-plane'
MARKER = 'share/hyperfide/qualified/26.4.json'
RECEIPT_DIGEST = 'c6acb6ed761cd7cbb0663969ac302859875426e83e7068bff63f9571effb3869'
UNITS = ['supervisory-host', 'issue-watcher']
TEMPLATES = {
    'supervisory-host': {'supervisory-host.json': 'config/supervisory-host.example.json', 'supervisory-host-policy.json': 'policies/supervisory-host.example.json',
                         'main-budget.json': 'config/main-budget.example.json'},
    'issue-watcher': {'issue-watcher.json': 'config/issue-watcher.example.json'},
}
OWNER = {'supervisory-host': (0, 0), 'issue-watcher': (1900, 1900)}
WATCHER_ACTIONS = ['identity.describe', 'finding.github.reconcile', 'finding.github.due', 'finding.github.dispatch', 'finding.github.process-delivery']
FAILED = []


def expect(value, message):
    if not value:
        raise AssertionError(message)


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = str(error)[:2000]
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


def node(code, *args, env=None):
    p = subprocess.run(['node', '--input-type=module', '-e', code, *map(str, args)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout, p.stderr


def releases_call(expr, *args):
    code = "const m=await import(process.env.RELEASES_MODULE);const a=process.argv.slice(1);" \
           "try{console.log(JSON.stringify({ok:true,value:await (" + expr + ")}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code??String(e)}));}"
    rc, out, err = node(code, *args, env=dict(os.environ, RELEASES_MODULE=(SERVICE / 'dist/deployment/releases.js').as_uri()))
    expect(rc == 0, err)
    return json.loads(out.strip().splitlines()[-1])


def bootstrap(script, args, env=None, code=None):
    p = subprocess.run(['node', str(script), *map(str, args)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    result = json.loads(p.stdout)
    expect(result['services_started'] is False, result)
    expect(p.returncode == (78 if code else 0), (p.returncode, result, p.stderr))
    expect(result['outcome'] == ('REFUSED' if code else 'SUCCEEDED'), result)
    if code:
        expect(result['error']['code'] == code, result)
    return result


def receipt_path():
    """The 26.4 receipt from the repository's local artifacts cache, shared by its worktrees."""
    if os.environ.get('HYPERFIDE_RELEASE_UNIT_RECEIPT'):
        return Path(os.environ['HYPERFIDE_RELEASE_UNIT_RECEIPT'])
    common = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    for base in [ROOT, Path(common).parent if common else ROOT]:
        candidate = base / 'artifacts/hyperfide/tasks/26.4/evidence-index.json'
        if candidate.is_file():
            return candidate
    return ROOT / 'artifacts/hyperfide/tasks/26.4/evidence-index.json'


def ensure_dist():
    stamp = subprocess.run(['node', str(DEPLOY / 'dist-stamp.mjs'), 'check', str(SERVICE)], capture_output=True, text=True, timeout=120)
    if stamp.returncode == 0 and json.loads(stamp.stdout).get('fresh'):
        return
    built = subprocess.run(['npm', 'run', 'build'], cwd=SERVICE, capture_output=True, text=True, timeout=900)
    if built.returncode:
        raise SystemExit('services dist could not be built: ' + built.stdout[-2000:] + built.stderr[-2000:])


def release_tree(scratch, name, marker=None):
    """A release layout: deploy/hyperfide as shipped, the service dist reached as core/control-plane, and optionally the marker."""
    rel = scratch / name
    shutil.copytree(DEPLOY, rel / 'deploy/hyperfide', ignore=shutil.ignore_patterns('identity'))
    (rel / 'deploy/hyperfide/identity').mkdir()
    for item in (DEPLOY / 'identity').glob('*.example.json'):
        shutil.copyfile(item, rel / 'deploy/hyperfide/identity' / item.name)
    (rel / 'services').mkdir()
    (rel / 'core/control-plane').symlink_to(SERVICE)
    if marker:
        r = releases_call('m.stageUnitReceipt(a[0],a[1])', rel, marker)
        expect(r['ok'] and r['value']['staged'], r)
    return rel / 'deploy/hyperfide/bootstrap-host.mjs'


def main():
    if os.geteuid() != 0:
        print('SKIP: bootstrap into a temporary root needs root for chown and useradd --root', flush=True)
        return 77
    ensure_dist()
    receipt = receipt_path()
    scratch = Path(tempfile.mkdtemp(prefix='hf-v21-2-9-'))
    try:
        def units_shipped():
            for name in UNITS:
                lines = (DEPLOY / f'{name}.service').read_text().splitlines()
                expect([x for x in lines if x.startswith('ConditionPathExists')] == ['ConditionPathExists=/opt/hyperfide/current/' + MARKER], (name, 'start condition is not the receipt marker'))
                expect(lines[-2:] == ['[Install]', 'WantedBy=multi-user.target'], (name, 'no Install section'))
                expect([x for x in lines if x.startswith('ExecStart=')] == [f'ExecStart=/opt/hyperfide/current/bin/hyperfide {name} --config /etc/hyperfide/{name}.json'], name)
                expect(f'EnvironmentFile=/etc/hyperfide/{name}.env' in lines, name)
        check('units.install-and-marker-condition', units_shipped)

        def templates_tracked():
            for role, templates in TEMPLATES.items():
                for rel in [f'env/{role}.env.example', *templates.values()]:
                    path = 'deploy/hyperfide/' + rel
                    expect((ROOT / path).is_file(), path + ' absent')
                    expect(subprocess.run(['git', 'check-ignore', '-q', '--no-index', path], cwd=ROOT).returncode != 0, path + ' is ignored')
                    if rel.endswith('.json'):
                        json.loads((ROOT / path).read_text())
            env = (DEPLOY / 'env/supervisory-host.env.example').read_text()
            expect(not [x for x in env.splitlines() if x and not x.startswith('#')], 'supervisory host env template assigns a variable')
            config = json.loads((DEPLOY / 'config/supervisory-host.example.json').read_text())
            expect(config['policy_file'] == '/etc/hyperfide/supervisory-host-policy.json' and config['control_uid'] == 1900 and config['control_gid'] == 1900, config)
            watcher = json.loads((DEPLOY / 'config/issue-watcher.example.json').read_text())
            expect(watcher['interval_seconds'] == 600 and watcher['cadence_amendment'] is None, 'watcher template leaves the ten-minute baseline')
            allowed = json.loads((DEPLOY / 'policies/control.example.json').read_text())['allowed_actions']
            expect(all(a in allowed for a in WATCHER_ACTIONS), [a for a in WATCHER_ACTIONS if a not in allowed])
        check('templates.tracked-and-consistent', templates_tracked)

        host = scratch / 'host'
        first = {}

        def bootstrap_both_roles():
            first.update(bootstrap(DEPLOY / 'bootstrap-host.mjs', ['--root', host]))
            etc = host / 'etc/hyperfide'
            expect(sorted(u['user'] for u in first['users']) == ['hyperfide', 'hyperfide-dispatch', 'hyperfide-provisioner'], first['users'])
            passwd = (host / 'etc/passwd').read_text().splitlines()
            expect(sum(1 for x in passwd if x.startswith('hyperfide:')) == 1 and sum(1 for x in passwd if x.startswith('root:')) == 1, passwd)
            for role in UNITS:
                unit = host / f'etc/systemd/system/hyperfide-{role}.service'
                expect(unit.read_bytes() == (DEPLOY / f'{role}.service').read_bytes(), role + ' unit differs')
                expect(stat.S_IMODE(unit.stat().st_mode) == 0o644, role)
                dropins = Path(str(unit) + '.d')
                expect(sorted(x.name for x in dropins.iterdir()) == ['preflight.conf'], (role, 'supervision units get no db-env drop-in'))
                expect((dropins / 'preflight.conf').read_text() == f'[Service]\nExecStartPre=/opt/hyperfide/current/runtime/node /opt/hyperfide/current/deploy/hyperfide/bootstrap-host.mjs --preflight {role}\n', role)
                env = etc / f'{role}.env'
                expect(env.read_bytes() == (DEPLOY / f'env/{role}.env.example').read_bytes(), role)
                s = env.stat()
                expect((s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (0, 0, 0o600), (role, 'env ownership'))
                for name, template in TEMPLATES[role].items():
                    placed = etc / name
                    expect(placed.read_bytes() == (DEPLOY / template).read_bytes(), name)
                    s = placed.stat()
                    expect((s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (*OWNER[role], 0o600), (name, s.st_uid, s.st_gid, oct(s.st_mode)))
                expect(not (host / f'var/lib/hyperfide/{role}/authority-journal').exists(), role + ' got an authority journal')
            for path, want in [('var/lib/hyperfide/supervisory-host', (0, 1900, 0o750)), ('var/lib/hyperfide/supervisory-host/state', (0, 0, 0o700)),
                               ('var/lib/hyperfide/supervisory-host/plans', (0, 0, 0o700)), ('var/lib/hyperfide/supervisory-host/socket', (0, 1900, 0o750))]:
                s = (host / path).stat()
                expect((s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == want, (path, s.st_uid, s.st_gid, oct(s.st_mode)))
            for name in ['issue-watcher.key', 'issue-watcher-ca.crt']:
                expect('/etc/hyperfide/' + name in first['operator_pending'], (name, first['operator_pending']))
            expect(not [p for p in first['operator_pending'] if 'supervisory-host' in p], first['operator_pending'])
            expect((host / 'etc/systemd/system/hyperfide-control.service').is_file(), 'authority roles still bootstrap')
        check('bootstrap.both-roles-temp-root', bootstrap_both_roles)

        def rerun_keeps():
            again = bootstrap(DEPLOY / 'bootstrap-host.mjs', ['--root', host])
            expect(again['created'] == [] and again['differs'] == [], again)
            for p in ['/etc/hyperfide/issue-watcher.json', '/etc/hyperfide/supervisory-host.json', '/etc/systemd/system/hyperfide-issue-watcher.service']:
                expect(p in again['kept'], (p, again['kept']))
        check('bootstrap.rerun-keeps', rerun_keeps)

        def missing_template_refuses():
            base = scratch / 'missing'
            shutil.copytree(DEPLOY, base / 'deploy/hyperfide')
            (base / 'deploy/hyperfide/config/issue-watcher.example.json').unlink()
            (base / 'deploy/hyperfide/supervisory-host.service').unlink()
            target = scratch / 'host-missing'
            r = bootstrap(base / 'deploy/hyperfide/bootstrap-host.mjs', ['--root', target], code='BOOTSTRAP_INPUT_MISSING')
            expect(sorted(r['error']['missing']) == ['deploy/hyperfide/config/issue-watcher.example.json', 'deploy/hyperfide/supervisory-host.service'], r)
            expect(not target.exists(), 'bootstrap wrote before refusing')
        check('bootstrap.missing-supervision-input', missing_template_refuses)

        def receipt_present():
            expect(receipt.is_file(), f'26.4 receipt absent at {receipt}; set HYPERFIDE_RELEASE_UNIT_RECEIPT to the artifact-store copy')
            expect(hashlib.sha256(receipt.read_bytes()).hexdigest() == RECEIPT_DIGEST, 'local 26.4 receipt differs from the pinned digest')
        check('marker.receipt-available', receipt_present)

        def marker_staged():
            stage = scratch / 'stage-ok'
            stage.mkdir()
            r = releases_call('m.stageUnitReceipt(a[0],a[1])', stage, receipt)
            expect(r['ok'] and r['value']['staged'] and r['value']['marker'] == MARKER, r)
            expect(r['value']['units'] == [{'unit': u, 'status': 'INSTALLABLE', 'owner_task': '26.4'} for u in ['issue-watcher.service', 'supervisory-host.service']], r)
            expect((stage / MARKER).read_bytes() == receipt.read_bytes() and stat.S_IMODE((stage / MARKER).stat().st_mode) == 0o644, 'staged marker differs')
            again = releases_call('m.stageUnitReceipt(a[0],a[1])', stage, receipt)
            expect(not again['ok'], ('second staging must not overwrite', again))
        check('marker.staged-from-receipt', marker_staged)

        def marker_absent():
            stage = scratch / 'stage-absent'
            stage.mkdir()
            r = releases_call('m.stageUnitReceipt(a[0],a[1])', stage, scratch / 'no-receipt.json')
            expect(r['ok'] and r['value']['staged'] is False and all(u['status'] == 'UNQUALIFIED' for u in r['value']['units']), r)
            expect(not (stage / 'share').exists(), 'marker shipped without a receipt')
        check('marker.absent-ships-unstartable', marker_absent)

        def marker_tampered():
            stage = scratch / 'stage-tampered'
            stage.mkdir()
            forged = scratch / 'forged.json'
            forged.write_bytes(receipt.read_bytes() + b' ')
            r = releases_call('m.stageUnitReceipt(a[0],a[1])', stage, forged)
            expect(not r['ok'] and r['code'] == 'RELEASE_INVALID', r)
            expect(not (stage / MARKER).exists(), 'tampered receipt staged')
            link = scratch / 'link.json'
            link.symlink_to(receipt)
            r = releases_call('m.stageUnitReceipt(a[0],a[1])', stage, link)
            expect(not r['ok'] and r['code'] == 'RELEASE_INVALID', r)
        check('marker.tampered-or-linked-refused', marker_tampered)

        def release_sh_stages():
            # The full release needs the pinned remote toolchain, so the staging program release.sh carries is
            # lifted out and executed exactly as release.sh invokes it (node -e, the built releases.js bound
            # through HYPERFIDE_RELEASES_MODULE); the assertions read its printed result and the staged tree.
            text = (ROOT / 'tools/repository/release.sh').read_text()
            expect(subprocess.run(['bash', '-n', str(ROOT / 'tools/repository/release.sh')]).returncode == 0, 'release.sh syntax')
            program = re.search(r'^ stage_code="(.+)"$', text, re.M)
            expect(program, 'release.sh carries no marker staging program')

            def stage_as_release(stage, unit_receipt):
                stage.mkdir()
                p = subprocess.run(['node', '--input-type=module', '-e', program.group(1), str(stage), str(unit_receipt)], cwd=SERVICE, capture_output=True, text=True, timeout=120,
                                   env=dict(os.environ, HYPERFIDE_RELEASES_MODULE=(SERVICE / 'dist/deployment/releases.js').as_uri()))
                return p.returncode, (json.loads(p.stdout.strip().splitlines()[-1]) if p.returncode == 0 else p.stderr)
            rc, out = stage_as_release(scratch / 'release-stage', receipt)
            expect(rc == 0 and out['staged'] and out['marker'] == MARKER, out)
            expect((scratch / 'release-stage' / MARKER).read_bytes() == receipt.read_bytes(), 'release staging did not ship the receipt as the marker')
            rc, out = stage_as_release(scratch / 'release-stage-absent', scratch / 'absent-receipt.json')
            expect(rc == 0 and out['staged'] is False and not (scratch / 'release-stage-absent/share').exists(), out)
            forged = scratch / 'release-forged.json'
            forged.write_bytes(receipt.read_bytes() + b'\n')
            rc, out = stage_as_release(scratch / 'release-stage-forged', forged)
            expect(rc != 0 and 'RELEASE_INVALID' in out, ('release staging accepted a forged receipt', out))
        check('release-sh.stages-marker', release_sh_stages)

        def inspector_from_marker():
            payload = scratch / 'payload'
            for name in ['bin/hyperfide', 'bin/cg', 'bin/hyperfide-native', 'runtime/node', 'runtime/python/bin/python3', 'runtime/python/bin/python3.bin',
                         'runtime/python/lib/python3.14/ctypes/__init__.py', 'services/package.json', 'services/package-lock.json', 'services/dist/control.js',
                         'services/dist/provisioner.js', 'services/dist/dispatch.js', 'lib/hyperfide/fixture.so', 'services/node_modules/fixture/package.json']:
                (payload / name).parent.mkdir(parents=True, exist_ok=True)
                (payload / name).write_bytes(b'inspection fixture\n')
            for name in ['control', 'dispatch', 'provisioner', *UNITS]:
                (payload / 'deploy/hyperfide').mkdir(parents=True, exist_ok=True)
                shutil.copyfile(DEPLOY / f'{name}.service', payload / f'deploy/hyperfide/{name}.service')

            def inspect():
                files = []
                for target in sorted(payload.rglob('*')):
                    if target.is_file() and target.name != 'manifest.json':
                        target.chmod(0o644)
                        data = target.read_bytes()
                        files.append({'path': target.relative_to(payload).as_posix(), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size_bytes': str(len(data)), 'mode': '0644'})
                (payload / 'manifest.json').write_text(json.dumps({'schema_version': 1, 'release_version': '2.0.0-dev', 'source_commit': 'a' * 40, 'source_date_epoch': '1',
                    'protocol_version': 1, 'schema_min': 1, 'schema_max': 1, 'runtime': {'node': '24.22.0', 'npm': '11.19.1', 'python': '3.14.8', 'platform': 'linux',
                    'architecture': 'x64'}, 'files': files}))
                code = "const m=await import(process.env.RELEASES_MODULE);try{const r=await m.inspectPrebuiltRelease({HYPERFIDE_RELEASE_ROOT:process.argv[1]},'manifest.json');" \
                       "console.log(JSON.stringify({ok:true,units:r.service_units}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code,message:e.message}));}"
                rc, out, err = node(code, payload, env=dict(os.environ, RELEASES_MODULE=(SERVICE / 'dist/deployment/releases.js').as_uri()))
                expect(rc == 0, err)
                return json.loads(out.strip().splitlines()[-1])

            def statuses(r, want):
                expect(r['ok'], r)
                got = {u['unit']: u['status'] for u in r['units'] if u['unit'] in ('issue-watcher.service', 'supervisory-host.service')}
                expect(got == {'issue-watcher.service': want, 'supervisory-host.service': want}, r)
            statuses(inspect(), 'UNQUALIFIED')
            r = releases_call('m.stageUnitReceipt(a[0],a[1])', payload, receipt)
            expect(r['ok'] and r['value']['staged'], r)
            statuses(inspect(), 'INSTALLABLE')
            unit = payload / 'deploy/hyperfide/issue-watcher.service'
            original = unit.read_text()
            unit.write_text(original.replace('ConditionPathExists=/opt/hyperfide/current/' + MARKER, 'ConditionPathExists=/opt/hyperfide/current/share/hyperfide/qualified/issue-watcher'))
            r = inspect()
            expect(not r['ok'] and r['code'] == 'RELEASE_INVALID', ('a unit gated on another marker must be refused', r))
            unit.write_text(original.replace('ConditionPathExists=/opt/hyperfide/current/' + MARKER + '\n', ''))
            r = inspect()
            expect(not r['ok'] and r['code'] == 'RELEASE_INVALID', ('an installable unit without the marker condition must be refused', r))
            unit.write_text(original)
        check('inspector.qualifies-only-from-marker', inspector_from_marker)

        def preflight():
            base = {k: v for k, v in os.environ.items() if not k.startswith(('HYPERFIDE_', 'HF_'))}
            env = dict(base, HYPERFIDE_BOOTSTRAP_ROOT=str(host))
            unqualified = release_tree(scratch, 'rel-unqualified')
            r = bootstrap(unqualified, ['--preflight', 'issue-watcher'], env, code='UNIT_UNQUALIFIED')
            expect(sorted(r['error']['missing']) == ['/etc/hyperfide/issue-watcher-ca.crt', '/etc/hyperfide/issue-watcher.key'], r)
            bootstrap(unqualified, ['--preflight', 'supervisory-host'], env, code='UNIT_UNQUALIFIED')
            qualified = release_tree(scratch, 'rel-qualified', marker=receipt)
            r = bootstrap(qualified, ['--preflight', 'issue-watcher'], env, code='PREFLIGHT_INPUT_MISSING')
            expect(sorted(r['error']['missing']) == ['/etc/hyperfide/issue-watcher-ca.crt', '/etc/hyperfide/issue-watcher.key'], r)
            # Placed templates still hold placeholders, so the configuration refuses until the operator replaces them.
            bootstrap(qualified, ['--preflight', 'supervisory-host'], env, code='SUPERVISORY_CONFIG_INVALID')
            etc = host / 'etc/hyperfide'
            for name in ['issue-watcher.key', 'issue-watcher-ca.crt']:
                (etc / name).write_text('operator material\n')
            bootstrap(qualified, ['--preflight', 'issue-watcher'], env, code='WATCHER_CONFIG_INVALID')
            config = json.loads((etc / 'supervisory-host.json').read_text())
            config.update(allowed_uids=[2001], max_children=4, policy_sha256='0' * 64, termination_grace_seconds=5, max_output_bytes=1048576)
            (etc / 'supervisory-host.json').write_text(json.dumps(config))
            r = bootstrap(qualified, ['--preflight', 'supervisory-host'], env)
            expect(r['qualified_by'] == '26.4', r)
            watcher = json.loads((etc / 'issue-watcher.json').read_text())
            watcher.update(organisation_id='11111111-1111-4111-8111-111111111111', run_id='22222222-2222-4222-8222-222222222222',
                           credential_id='33333333-3333-4333-8333-333333333333', control_origin='https://control.example.test',
                           repositories=[{'repository_id': '44444444-4444-4444-8444-444444444444', 'owner': 'example', 'repository': 'repository'}],
                           due_limit=10, request_timeout_ms=10000)
            (etc / 'issue-watcher.json').write_text(json.dumps(watcher))
            bootstrap(qualified, ['--preflight', 'issue-watcher'], env)
            (etc / 'main-budget.json').unlink()
            r = bootstrap(qualified, ['--preflight', 'supervisory-host'], env, code='PREFLIGHT_INPUT_MISSING')
            expect(r['error']['missing'] == ['/etc/hyperfide/main-budget.json'], r)
            # Tampering with the shipped marker makes the same check refuse even though systemd's existence condition holds.
            marker = qualified.parents[2] / MARKER
            marker.write_bytes(marker.read_bytes() + b' ')
            bootstrap(qualified, ['--preflight', 'issue-watcher'], env, code='UNIT_UNQUALIFIED')
        check('preflight.marker-files-config', preflight)
    finally:
        shutil.rmtree(scratch)
        print(json.dumps(dict(type='cleanup', resources=[], complete=not scratch.exists())), flush=True)
    return int(bool(FAILED))


if __name__ == '__main__':
    sys.exit(main())
