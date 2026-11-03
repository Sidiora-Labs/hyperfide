#!/usr/bin/env python3
"""Exercise product source actions against the real native service."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('native_source_fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py')
fixture=importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def main():
    inside_owned_database=bool(os.environ.get('DATABASE_URL'))
    environment={'HF_SOURCE_BROWSER':os.environ.get('HF_SOURCE_BROWSER','1'),'NODE_OPTIONS':'--import='+str(ROOT/'node_modules/tsx/dist/loader.mjs')+' --conditions=source'}
    result=fixture.run_source_actor(ROOT/'tests/hyperfide/support/native_source_product_actor.mjs',migrations=[
        '0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql',
        '0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0742-source-control-publication.sql','0743-source-control-assurance.sql','0753-source-control-transfers.sql'],timeout=180,actor_env=environment)
    if not inside_owned_database:
        return result
    if result != 0:
        return result
    if os.environ.get('HF_SOURCE_PRODUCT_CLI', '1') == '0':
        return 0
    build=subprocess.run(['node',str(ROOT/'tools/workspace/build-package.mjs')],cwd=ROOT/'sdk/source-control')
    if build.returncode != 0:
        return build.returncode
    plugin_build=subprocess.run(['node','prepare.mjs'],cwd=ROOT/'plugins/environment-slices')
    if plugin_build.returncode != 0:
        return plugin_build.returncode
    child_env={key:value for key,value in os.environ.items() if key not in ('DATABASE_URL','HF_SOURCE_QUALIFICATION')}
    child_env['HF_SOURCE_PRODUCT_CLI']='1'
    return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/cases/source_control/signed_transport.py')],cwd=ROOT,env=child_env).returncode

if __name__=='__main__':
    raise SystemExit(main())
