#!/usr/bin/env python3
"""Run bounded source workload checks or an explicit measured campaign."""
import argparse
import importlib.util
import os
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

if __name__ == '__main__':
    scheduler = subprocess.run(['node', '--test', str(ROOT / 'tests/hyperfide/source-control/workloads/campaign_scheduler.test.mjs')], cwd=ROOT, capture_output=True, text=True)
    if scheduler.returncode:
        raise RuntimeError(scheduler.stdout + scheduler.stderr)
    parser = argparse.ArgumentParser()
    parser.add_argument('--campaign', type=Path, default=os.environ.get('HF_SOURCE_WORKLOAD_MANIFEST'))
    parser.add_argument('--live-s3', action='store_true')
    parser.add_argument('--verify-completed', action='store_true', help='Read-only verification of a completed durable campaign')
    parser.add_argument('--deployment-config', type=Path, default=os.environ.get('HF_SOURCE_WORKLOAD_CONFIG'), help='Private deployed API, renewable credential file and pinned observer configuration')
    args = parser.parse_args()
    if not args.campaign and os.environ.get('DATABASE_URL'):
        checks=subprocess.run(['node','--test',str(ROOT/'tests/hyperfide/source-control/workloads/hardware.test.mjs'),str(ROOT/'tests/hyperfide/source-control/workloads/campaign_scheduler.test.mjs'),str(ROOT/'tests/hyperfide/source-control/workloads/ledger_recovery.test.mjs')],cwd=ROOT)
        if checks.returncode:raise SystemExit(checks.returncode)
        print(json.dumps({'type':'assertion','id':'source-workload.hardware-identity','expected':True,'actual':True}),flush=True)
        print(json.dumps({'type':'assertion','id':'source-workload.resume-ledger','expected':True,'actual':True}),flush=True)
    env = {}
    if args.campaign:
        if not args.live_s3 or not args.deployment_config:
            parser.error('Full campaigns require --live-s3 and --deployment-config for an isolated deployed source service')
        env['HF_SOURCE_WORKLOAD_MANIFEST'] = str(args.campaign.resolve())
        env['HF_SOURCE_WORKLOAD_CONFIG'] = str(args.deployment_config.resolve())
        if args.verify_completed:
            env['HF_SOURCE_WORKLOAD_VERIFY_ONLY'] = '1'
        with tempfile.TemporaryDirectory(prefix='hf-source-campaign-sdk-') as temporary:
            folder=Path(temporary)
            (folder/'package.json').write_text('{"type":"module"}')
            subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(ROOT/'sdk/source-control/tsconfig.json'),'--outDir',str(folder/'sdk')],cwd=ROOT,check=True)
            env=dict(os.environ,**env,SOURCE_CONTROL_SDK_MODULE_ROOT=str(folder/'sdk'))
            env.pop('DATABASE_URL',None)
            manifest=json.loads(args.campaign.read_text())
            raise SystemExit(subprocess.run(['node',str(ROOT/'tests/hyperfide/support/native_source_external_workload.mjs')],cwd=ROOT,env=env,timeout=int(manifest['duration_seconds'])+7200).returncode)
    elif args.live_s3 or args.deployment_config or args.verify_completed:
        parser.error('--live-s3 requires an explicit campaign manifest')
    raise SystemExit(fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_workload.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql',
        '0746-source-control-retention.sql',
    ], timeout=300000 if args.campaign else 300, actor_env=env))
