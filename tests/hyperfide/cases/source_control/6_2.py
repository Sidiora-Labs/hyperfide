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
    parser = argparse.ArgumentParser()
    parser.add_argument('--campaign', type=Path, default=os.environ.get('HF_SOURCE_WORKLOAD_MANIFEST'))
    parser.add_argument('--live-s3', action='store_true')
    parser.add_argument('--deployment-config', type=Path, default=os.environ.get('HF_SOURCE_WORKLOAD_CONFIG'), help='Private deployed API, renewable credential file and pinned observer configuration')
    args = parser.parse_args()
    env = {}
    if args.campaign:
        if not args.live_s3 or not args.deployment_config:
            parser.error('Full campaigns require --live-s3 and --deployment-config for an isolated deployed source service')
        env['HF_SOURCE_WORKLOAD_MANIFEST'] = str(args.campaign.resolve())
        env['HF_SOURCE_WORKLOAD_CONFIG'] = str(args.deployment_config.resolve())
        with tempfile.TemporaryDirectory(prefix='hf-source-campaign-sdk-') as temporary:
            folder=Path(temporary)
            (folder/'package.json').write_text('{"type":"module"}')
            subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(ROOT/'sdk/source-control/tsconfig.json'),'--outDir',str(folder/'sdk')],cwd=ROOT,check=True)
            env=dict(os.environ,**env,SOURCE_CONTROL_SDK_MODULE_ROOT=str(folder/'sdk'))
            env.pop('DATABASE_URL',None)
            manifest=json.loads(args.campaign.read_text())
            raise SystemExit(subprocess.run(['node',str(ROOT/'tests/hyperfide/support/native_source_external_workload.mjs')],cwd=ROOT,env=env,timeout=int(manifest['duration_seconds'])+7200).returncode)
    elif args.live_s3 or args.deployment_config:
        parser.error('--live-s3 requires an explicit campaign manifest')
    raise SystemExit(fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_workload.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql',
        '0746-source-control-retention.sql',
    ], timeout=300000 if args.campaign else 300, actor_env=env))
