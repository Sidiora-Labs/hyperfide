#!/usr/bin/env python3
"""Receipt-gated unit transition plus the unchanged release integration gates."""
import importlib.util
import json
import subprocess
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
import {serviceUnitStatus} from './services/hyperfide/dist/deployment/releases.js';
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
 assert.equal(receipt.commit,'ff4632c9bc896057147975b600323af8f8b21f89');
 const gates=receipt.stdout_tail.trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(gates.map(x=>x.receipt_id),['cf29a831-73ed-42c3-928b-7c3a41563a36','2ed47892-7b68-4178-9580-444790e1eb6b']);
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
                release.expect((ROOT / 'services/hyperfide' / suffix).is_file(), '26.4 entrypoint absent')
    release.check('units.shipped-entrypoints', entrypoints)
    return release.main()


if __name__ == '__main__':
    raise SystemExit(main())
