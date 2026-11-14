#!/usr/bin/env python3
"""Exercise native retention and collection against owned PostgreSQL and signed S3."""
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[4]

def main():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    os.environ['SOURCE_COLLECTION_REVISION'] = revision
    output = Path(os.environ.get('HYPERFIDE_SOURCE_EVIDENCE_DIR', str(ROOT / 'build/source-control/2.3'))).resolve()
    os.environ['HYPERFIDE_SOURCE_EVIDENCE_DIR'] = str(output)
    output.mkdir(parents=True, exist_ok=True)
    if not os.environ.get('DATABASE_URL'):
        modes=['--api'] if '--api' in sys.argv else ['--component','--api']
        for mode in modes:
            result=subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),mode],cwd=ROOT)
            if result.returncode:return result.returncode
        receipts = ['api-receipt.json'] if '--api' in sys.argv else ['receipt.json', 'api-receipt.json']
        evidence = []
        for name in receipts:
            payload = (output / name).read_bytes()
            receipt = json.loads(payload)
            assert receipt['status'] == 'PASS' and receipt['revision'] == revision
            assert receipt['checks'], 'Collection actor must execute its assertions'
            evidence.append({'path': str(output / name), 'sha256': hashlib.sha256(payload).hexdigest()})
        (output / 'qualification.json').write_text(json.dumps({'status': 'PASS', 'revision': revision, 'receipts': evidence}, indent=2) + '\n')
        return 0
    if '--api' in sys.argv:
        spec=importlib.util.spec_from_file_location('source_fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py')
        fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
        return fixture.run_source_actor(ROOT/'tests/hyperfide/support/native_source_collection_api.mjs',migrations=['0001-authority.sql','0002-spec.sql','0003-hierarchy.sql','0004-durability.sql','0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql','0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0743-source-control-assurance.sql','0746-source-control-retention.sql','0742-source-control-publication.sql','0752-source-control-recovery.sql','0764-source-control-publication-credentials.sql'])
    host = parse_qs(urlparse(os.environ['DATABASE_URL']).query).get('host', [''])[0]
    if not host.startswith('/tmp/hyperfide/hf-withpg-'):
        raise RuntimeError('Retention qualification requires an owned PostgreSQL socket')
    output = Path(os.environ.get('HYPERFIDE_SOURCE_EVIDENCE_DIR',str(ROOT/'build/source-control/2.3'))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = ['contracts.ts','storage_contract.ts','object_catalog.ts','objects.ts','trees.ts','s3.ts','pins.ts','gc.ts']
    config = {'compilerOptions': {'target':'ES2023','module':'NodeNext','moduleResolution':'NodeNext','strict':True,'noUncheckedIndexedAccess':True,'exactOptionalPropertyTypes':True,'skipLibCheck':True,'rootDir':str(ROOT/'core/control-plane/src'),'outDir':str(output/'dist'),'types':['node'],'typeRoots':[str(ROOT/'core/control-plane/node_modules/@types')]}, 'files':[str(ROOT/'core/control-plane/src/source_control'/file) for file in files]}
    filename=output/'tsconfig.json';filename.write_text(json.dumps(config))
    subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(filename)],cwd=ROOT,check=True)
    return subprocess.run(['node',str(ROOT/'tests/hyperfide/support/native_source_collection.mjs'),str(output/'dist/source_control')],cwd=ROOT).returncode

if __name__=='__main__':
    raise SystemExit(main())
