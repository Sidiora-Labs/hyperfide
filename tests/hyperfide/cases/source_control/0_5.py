#!/usr/bin/env python3
"""Exercise relocated native/control consumers without rebuilding their artifacts."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'build/layout/0.5'
TOOLCHAIN=ROOT/'tests/hyperfide/support/layout_toolchain.py'
sys.path.insert(0,str(TOOLCHAIN.parent))
from layout_toolchain import node_tool
NODE=node_tool('24.22.0','HYPERFIDE_LAYOUT_NODE24')
BINARY=ROOT/'hyperfide'
NATIVE=ROOT/'build/hyperfide-native'
SERVICE=ROOT/'core/control-plane'

def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def require(value,message):
 if not value:raise RuntimeError(message)
def run(argv,**kwargs):
 p=subprocess.run(list(map(str,argv)),text=True,capture_output=True,timeout=90,**kwargs)
 print(json.dumps({'command':list(map(str,argv)),'exit_code':p.returncode,'stdout':p.stdout[-16000:],'stderr':p.stderr[-4000:]}),flush=True)
 return p

def native_probe():
 before={str(p.relative_to(ROOT)):sha(p) for p in [BINARY,NATIVE]}
 p=run([sys.executable,ROOT/'tools/repository/hyperfide-native-components.py','--check'],cwd=ROOT);require(p.returncode==0,'Relocated native component registry discovery failed')
 p=run([sys.executable,ROOT/'tools/repository/hyperfide-native-components.py','--sources'],cwd=OUT);require(p.returncode==0 and 'core/native/src/' in p.stdout,'Nested native source registry discovery failed')
 for cwd in [ROOT,ROOT/'core/native/src/hyperfide']:
  p=run([BINARY,'--version'],cwd=cwd);require(p.returncode==0 and p.stdout.strip(),'Native front door failed')
 for component,action in [('26.1','branding.identity.describe'),('26.4','entrypoint.launchers.describe'),('12.1','supervisor.describe')]:
  p=run([NATIVE,'--component',component,'--action',action],input='{}\n',cwd=OUT)
  require(p.returncode==0 and json.loads(p.stdout).get('ok') is True,'Actual linked component dispatch failed: '+component)
 require(before=={name:sha(ROOT/name) for name in before},'Native artifact changed during read-only probes')

def control_inner():
 sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
 from identity_fixture import IdentityFixture
 f=IdentityFixture(extra_components=['4.1'])
 try:
  tables=f.sql("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='hyperfide'")
  require(tables[0]['count']>50,'Actual relocated migrations did not initialize the production schema')
  status,response=f.invoke('identity.describe',{},component='14.1')
  require(status==200 and response.get('ok') is True,'Actual relocated control-plane registry/TLS bootstrap failed')
  print(json.dumps({'schema_tables':tables[0]['count'],'identity_result':response.get('result')}))
 finally:f.close()

def control_probe():
 env=os.environ.copy();env.pop('DATABASE_URL',None)
 env['PATH']=str(NODE.parent)+':/usr/sbin:/usr/bin:/bin'
 extracted=Path('/tmp/hyperfide-source-control-pg18/runtime')
 if (extracted/'usr/lib/postgresql/18/bin/initdb').is_file():
  env['HYPERFIDE_PG_BIN']=str(extracted/'usr/lib/postgresql/18/bin');env['LD_LIBRARY_PATH']=str(extracted/'usr/lib/x86_64-linux-gnu')
 p=run([sys.executable,ROOT/'tests/hyperfide/support/withpg.py','--',sys.executable,Path(__file__).resolve(),'--probe','control-inner'],env=env,cwd=ROOT)
 require(p.returncode==0,'Owned PostgreSQL/control bootstrap probe failed')

def core_probe():
 script="""import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.argv[1];const daemon=await import(pathToFileURL(root+'/core/host-daemon/dist/index.js'));
const archive=await import(pathToFileURL(root+'/core/server-archive/src/index.ts'));
assert.equal(typeof archive.assertServerArchiveFormat,'function');assert.equal(typeof archive.extractServerArchive,'function');
const db=await import(pathToFileURL(root+'/core/runtime-db/src/index.ts'));assert(Object.keys(db).length>10);
console.log(JSON.stringify({host_daemon_imported:true,archive_exports:Object.keys(archive).length,database_exports:Object.keys(db).length}));"""
 p=run([NODE,'--conditions=source','--import','tsx','--input-type=module','-e',script,ROOT],cwd=ROOT)
 require(p.returncode==0,'Relocated real core package consumers failed to import')
 module=ROOT/'core/kvx/impl/go/go.mod'
 baseline=run(['git','show','HEAD:kvx/impl/go/go.mod'],cwd=ROOT)
 if baseline.returncode==0:require(module.read_bytes()==baseline.stdout.encode(),'KVX Go public module identity changed')
 else:
  mapping=json.loads((ROOT/'spec/hyperfide-source-control/repository-layout.json').read_text())
  baseline=run(['git','show',mapping['implementation_baseline']+':kvx/impl/go/go.mod'],cwd=ROOT)
  require(baseline.returncode==0 and module.read_bytes()==baseline.stdout.encode(),'KVX baseline module identity unavailable or changed')


def installed_probe():
 installed=OUT/'installed'
 if installed.exists():shutil.rmtree(installed)
 (installed/'bin').mkdir(parents=True);(installed/'runtime').mkdir();(installed/'services').mkdir()
 os.link(BINARY,installed/'bin/hyperfide');os.link(NODE,installed/'runtime/node')
 for name in ['dist','migrations','components','node_modules']:
  shutil.copytree(SERVICE/name,installed/'services'/name,copy_function=os.link,symlinks=True)
 shutil.copy2(SERVICE/'package.json',installed/'services/package.json')
 inventory=[]
 for origin,copy in [(SERVICE/'dist',installed/'services/dist'),(SERVICE/'migrations',installed/'services/migrations'),(SERVICE/'components',installed/'services/components')]:
  for file in sorted(origin.rglob('*')):
   if file.is_file():
    target=copy/file.relative_to(origin);require(sha(file)==sha(target) and file.stat().st_mode==target.stat().st_mode,'Installed source content or mode changed')
    inventory.append({'source':str(file.relative_to(ROOT)),'installed':str(target.relative_to(ROOT)),'sha256':sha(file),'mode':oct(file.stat().st_mode&0o777)})
 (OUT/'installed-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
 nested=installed/'outside-repository/nested';nested.mkdir(parents=True)
 env=os.environ.copy()
 for key in ['HYPERFIDE_RELEASE_ROOT','HYPERFIDE_REPO_ROOT','HYPERFIDE_PLATFORM_BIN','DATABASE_URL']:env.pop(key,None)
 p=run([installed/'bin/hyperfide','--version'],cwd=nested,env=env);require(p.returncode==0,'Installed native front door failed')
 p=run([installed/'bin/hyperfide','bootstrap'],cwd=nested,env=env)
 require(p.returncode!=0 and json.loads((p.stdout or p.stderr).strip()).get('error',{}).get('code')=='INVALID_REQUEST','Installed launcher did not load its real adjacent packaged Node/bootstrap module')
 p=run([BINARY,'platform','--version'],cwd=ROOT/'core/native/src',env={**env,'PATH':str(NODE.parent)+':'+env.get('PATH','')})
 require(p.returncode==0 and p.stdout.strip(),'Actual relocated apps/cli discovery failed from nested source directory')

PROBES={'native':native_probe,'control':control_probe,'control-inner':control_inner,'core':core_probe,'installed':installed_probe}
def main():
 OUT.mkdir(parents=True,exist_ok=True)
 if len(sys.argv)==3 and sys.argv[1]=='--probe':PROBES[sys.argv[2]]();return 0
 module=importlib.util.spec_from_file_location('layout_final',Path(__file__).with_name('0_9.py'));gate=importlib.util.module_from_spec(module);module.loader.exec_module(gate)
 receipt={'schema_version':1,'task':'0.5',**gate.capture_bindings(),'status':'PASS','commands':[],'assertions':[],'artifacts':[],'missing_evidence':[],'scope':'Relocation consumer qualification; no application startup or provider certification'}
 common=[TOOLCHAIN,ROOT/'tests/hyperfide/support/identity_fixture.py',ROOT/'tests/hyperfide/support/withpg.py',ROOT/'tests/hyperfide/cases/support/postgres_cluster.py',Path(__file__).resolve(),Path(__file__).with_name('0_9.py').resolve(),BINARY,NATIVE,SERVICE/'dist/components/registry.js',SERVICE/'dist/control.js',SERVICE/'migrations/0001-authority.sql',ROOT/'tools/repository/hyperfide-native-components.py',ROOT/'core/host-daemon/dist/index.js',ROOT/'core/server-archive/src/index.ts',ROOT/'core/runtime-db/src/index.ts',ROOT/'core/kvx/impl/go/go.mod',ROOT/'apps/cli/dist/index.js',ROOT/'apps/cli/bin/hyperfide-platform']
 for probe,assertion in [('native','native-frontdoor-and-components'),('control','control-schema-component-bootstrap'),('core','core-runtime'),('installed','installed-cli-discovery')]:
  command=[sys.executable,str(Path(__file__).resolve()),'--probe',probe];started=time.monotonic();log=OUT/(probe+'.log')
  with log.open('w') as stream:
   p=subprocess.run(command,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT,text=True,timeout=300)
  receipt['commands'].append({'id':probe,'command':command,'exit_code':p.returncode,'duration_ms':round((time.monotonic()-started)*1000),'log':str(log.relative_to(ROOT)),'log_sha256':sha(log),'inputs':{str(file.relative_to(ROOT)):sha(file) for file in common}})
  receipt['assertions'].append({'id':assertion,'status':'PASS' if p.returncode==0 else 'FAIL','command_id':probe})
  if p.returncode:receipt['status']='BLOCKED';receipt['missing_evidence'].append({'id':assertion,'log':str(log.relative_to(ROOT))})
 for artifact in [OUT/'installed-inventory.json']:
  if artifact.is_file():receipt['artifacts'].append({'path':str(artifact.relative_to(ROOT)),'sha256':sha(artifact)})
 (OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2));return 0 if receipt['status']=='PASS' else 1
if __name__=='__main__':raise SystemExit(main())
