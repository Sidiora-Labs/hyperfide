#!/usr/bin/env python3
"""Exercise native source storage through PostgreSQL and its S3 HTTP boundary."""
import argparse,json,os,pathlib,subprocess,sys
from urllib.parse import urlparse,parse_qs
ROOT=pathlib.Path(__file__).resolve().parents[4]

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--live-s3',action='store_true');parser.add_argument('--component',action='store_true');args=parser.parse_args();args.live_s3=args.live_s3 or not args.component
 database=os.environ.get('DATABASE_URL','')
 if not database:
  command=[sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(pathlib.Path(__file__).resolve())]
  if args.live_s3:command.append('--live-s3')
  else:command.append('--component')
  return subprocess.run(command,cwd=ROOT).returncode
 host=parse_qs(urlparse(database).query).get('host',[''])[0]
 if not host.startswith('/tmp/hyperfide/hf-withpg-'):raise RuntimeError('Storage qualification requires an owned withpg socket')
 out=ROOT/'build/source-control/1.1';out.mkdir(parents=True,exist_ok=True)
 files=['contracts.ts','storage_contract.ts','object_catalog.ts','objects.ts','trees.ts','s3.ts']
 config={'compilerOptions':{'target':'ES2023','module':'NodeNext','moduleResolution':'NodeNext','rootDir':str(ROOT/'core/control-plane/src'),'outDir':str(out/'dist'),'strict':True,'noUncheckedIndexedAccess':True,'exactOptionalPropertyTypes':True,'skipLibCheck':True,'types':['node'],'typeRoots':[str(ROOT/'core/control-plane/node_modules/@types')]},'files':[str(ROOT/'core/control-plane/src/source_control'/file) for file in files]}
 config_path=out/'tsconfig.json';config_path.write_text(json.dumps(config))
 subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(config_path)],cwd=ROOT,check=True)
 command=['node',*(['--env-file-if-exists='+str(ROOT/'.env')] if args.live_s3 else []),str(ROOT/'tests/hyperfide/cases/source_control/fixtures/objects/storage.mjs'),str(out/'dist/source_control')]
 if args.live_s3:command.append('--live-s3')
 return subprocess.run(command,cwd=ROOT).returncode
if __name__=='__main__':raise SystemExit(main())
