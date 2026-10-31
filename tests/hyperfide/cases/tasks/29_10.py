#!/usr/bin/env python3
"""Receipt-gated unit transition plus the unchanged release integration gates."""
import importlib.util
import json
import subprocess
import hashlib
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('release_case', ROOT / 'tests/hyperfide/cases/tasks/25_4.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def main():
    script = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {serviceUnitStatus} from './core/control-plane/dist/deployment/releases.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unit-receipt-'));
const units=['issue-watcher.service','supervisory-host.service'];
const results={};
async function statuses(status){for(const unit of units)assert.deepEqual(await serviceUnitStatus(root,unit),{status,owner_task:'26.4'});}
try{
 await statuses('UNQUALIFIED');results['units.receipt.absent']=true;
 const filename=path.join(root,'share/hyperfide/qualified/26.4.json');
 await fs.mkdir(path.dirname(filename),{recursive:true});
 const bytes=await fs.readFile('artifacts/hyperfide/tasks/26.4/evidence-index.json');
 const receipt=JSON.parse(bytes);assert.equal(receipt.task,'26.4');assert.equal(receipt.exit_code,0);
 assert.equal(receipt.commit,'a923d185cd035c9620195fcf2d0e12c512e73d37');
 const gates=receipt.stdout_tail.trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(gates.map(x=>x.receipt_id),['1f08f3dd-3c2d-4c51-9258-fc13625b8bc2','b6dfd5e2-d6c7-418d-bd94-64d92106573f']);
 assert(gates.every(x=>x.status==='PASS'&&x.diagnostics.length===0));
 await fs.writeFile(filename,bytes);await statuses('INSTALLABLE');results['units.receipt.qualified']=true;
 await fs.writeFile(filename,Buffer.concat([bytes,Buffer.from(' ')]));
 await statuses('UNQUALIFIED');results['units.receipt.tampered']=true;
 await fs.unlink(filename);await fs.symlink(path.resolve('artifacts/hyperfide/tasks/26.4/evidence-index.json'),filename);
 await assert.rejects(serviceUnitStatus(root,units[0]),e=>e.code==='RELEASE_INVALID');results['units.receipt.symlink-refused']=true;
 await assert.rejects(serviceUnitStatus(root,'unknown.service'),e=>e.code==='RELEASE_INVALID');results['units.unknown-refused']=true;
}finally{await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.stat(root),e=>e.code==='ENOENT');}
console.log(JSON.stringify(results));
"""
    observed = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    results = json.loads(observed.stdout) if observed.returncode == 0 else {}
    for name in ['units.receipt.absent', 'units.receipt.qualified', 'units.receipt.tampered', 'units.receipt.symlink-refused', 'units.unknown-refused']:
        release.check(name, lambda name=name: release.expect(results.get(name) is True, observed.stderr or observed.stdout))

    def entrypoints():
        for name in ['supervisory-host', 'issue-watcher']:
            unit = (ROOT / f'deploy/hyperfide/{name}.service').read_text().splitlines()
            release.expect([x for x in unit if x.startswith('ExecStart=')] == [f'ExecStart=/opt/hyperfide/current/bin/hyperfide {name} --config /etc/hyperfide/{name}.json'], 'unit command/config differs')
            for suffix in ['src/' + name + '.ts', 'dist/' + name + '.js']:
                release.expect((ROOT / 'core/control-plane' / suffix).is_file(), '26.4 entrypoint absent')
    release.check('units.shipped-entrypoints', entrypoints)
    # Exercise the registered service API with a byte-inventory fixture. These
    # placeholders test release inspection only, not deployment or runtime gates.
    from shutil import copyfile
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from identity_fixture import IdentityFixture
    with tempfile.TemporaryDirectory(prefix='hf-unit-service-') as temporary:
        payload = Path(temporary) / 'payload'
        required = ['bin/hyperfide', 'bin/cg', 'bin/hyperfide-native', 'runtime/node',
                    'runtime/python/bin/python3', 'runtime/python/bin/python3.bin',
                    'runtime/python/lib/python3.14/ctypes/__init__.py', 'services/package.json',
                    'services/package-lock.json', 'services/dist/control.js',
                    'services/dist/provisioner.js', 'services/dist/dispatch.js',
                    'lib/hyperfide/fixture.so', 'services/node_modules/fixture/package.json']
        for name in required:
            target = payload / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'unit-inspection fixture\n')
            target.chmod(0o644)
        for name in ['control', 'dispatch', 'provisioner', 'issue-watcher', 'supervisory-host']:
            target = payload / f'deploy/hyperfide/{name}.service'
            target.parent.mkdir(parents=True, exist_ok=True)
            copyfile(ROOT / f'deploy/hyperfide/{name}.service', target)
            target.chmod(0o644)
        receipt = payload / 'share/hyperfide/qualified/26.4.json'
        manifest = payload / 'manifest.json'

        def pin(exclude_receipt=False):
            files = []
            for target in sorted(payload.rglob('*')):
                if not target.is_file() or target == manifest or exclude_receipt and target == receipt:
                    continue
                data = target.read_bytes()
                files.append({'path': target.relative_to(payload).as_posix(), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size_bytes': str(len(data)), 'mode': '0644'})
            manifest.write_text(json.dumps({'schema_version': 1, 'release_version': '1.0.0',
                'source_commit': 'a' * 40, 'source_date_epoch': '1', 'protocol_version': 1,
                'schema_min': 1, 'schema_max': 1, 'runtime': {'node': '24.22.0', 'npm': '11.19.1',
                'python': '3.14.8', 'platform': 'linux', 'architecture': 'x64'}, 'files': files}))

        fixture = IdentityFixture(extra_components=['25.4'], extra_env={'HYPERFIDE_RELEASE_ROOT': str(payload)})
        try:
            def inspect():
                status, response = fixture.invoke('release.inspect', {'manifest': 'manifest.json'}, component='25.4')
                return response

            def statuses(expected):
                response = inspect()
                release.expect(response.get('ok') is True, str(response))
                units = {u['unit']: u for u in response['result']['service_units']}
                for name in ['issue-watcher', 'supervisory-host']:
                    release.expect(units[name + '.service'] == {'unit': name + '.service', 'status': expected, 'owner_task': '26.4'}, str(units))

            pin()
            release.check('units.service.receipt-absent', lambda: statuses('UNQUALIFIED'))
            receipt.parent.mkdir(parents=True)
            copyfile(ROOT / 'artifacts/hyperfide/tasks/26.4/evidence-index.json', receipt)
            receipt.chmod(0o644)
            pin()
            release.check('units.service.receipt-qualified', lambda: statuses('INSTALLABLE'))
            receipt.write_bytes(receipt.read_bytes() + b' ')
            pin()
            release.check('units.service.receipt-tampered', lambda: statuses('UNQUALIFIED'))
            copyfile(ROOT / 'artifacts/hyperfide/tasks/26.4/evidence-index.json', receipt)
            pin(exclude_receipt=True)
            def unpinned():
                response = inspect()
                release.expect(response.get('ok') is False and response['error']['code'] == 'RELEASE_INVALID', str(response))
            release.check('units.service.unpinned-receipt-refused', unpinned)
        finally:
            database, role, private = fixture.database, fixture.runtime_role, fixture.path
            fixture.close()
        absent = not fixture.sql('SELECT datname FROM pg_database WHERE datname=$1', [database], admin=True) and not fixture.sql('SELECT rolname FROM pg_roles WHERE rolname=$1', [role], admin=True) and not private.exists()
    absent = absent and not Path(temporary).exists()
    release.check('units.cleanup.observed-absence', lambda: release.expect(absent, 'unit fixtures remain'))
    (release.artifacts() / 'cleanup.json').write_text(json.dumps({'observed_absent': absent}))
    (release.artifacts() / 'observations.json').write_text(json.dumps({'scope': 'task-component', 'assertion_ids': release.IDS, 'failed_ids': release.FAILED, 'fixture': 'release.inspect byte inventory; not a deployable runtime'}))
    return 1 if release.FAILED else 0


if __name__ == '__main__':
    raise SystemExit(main())
