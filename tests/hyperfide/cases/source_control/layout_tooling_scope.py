#!/usr/bin/env python3
"""Check repaired tooling selection through actual CLI discovery and owner fixtures."""
import ast
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'build/layout/0.8-tooling-repair'
TOOLCHAIN=ROOT/'tests/hyperfide/support/layout_toolchain.py'
sys.path.insert(0,str(TOOLCHAIN.parent))
from layout_toolchain import node_tool,pnpm_tool
NODE=node_tool((ROOT/'.nvmrc').read_text().strip(),'HYPERFIDE_LAYOUT_NODE22')
PNPM=pnpm_tool(ROOT,NODE)
MAPPING=ROOT/'spec/hyperfide-source-control/repository-layout.json'
SCOPE=ROOT/'tools/workspace/source-roots.json'
NAMES=['0_2','0_3','0_5','1_2','3_1','3_3','6_1','6_2','6_3','6_4']
AFFECTED=[ROOT/f'tests/hyperfide/cases/v22/{name}.sh' for name in NAMES]+[ROOT/'tests/hyperfide/closure_check.py',ROOT/'tests/integration/66_sem_resolve.sh',ROOT/'tools/workspace/remove-typescript-comments.mjs']

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git','-C',str(ROOT),*args])
def main():
 OUT.mkdir(parents=True,exist_ok=True)
 mapping=json.loads(MAPPING.read_text());rules=sorted(mapping['mappings'],key=lambda r:-len(r['source']))
 def mapped(name):
  for row in rules:
   if name==row['source'] or name.startswith(row['source']+'/'):return row['destination']+name[len(row['source']):]
  return name
 baseline=mapping['implementation_baseline'];layout='fc5ea53bb00d659196c9fceee62fae75720fa22c'
 originals={str(p.relative_to(ROOT)):git('show',baseline+':'+str(p.relative_to(ROOT))).decode() for p in AFFECTED[:10]}
 inputs={str(p.relative_to(ROOT)):digest(p) for p in [TOOLCHAIN,*AFFECTED,SCOPE,MAPPING,Path(__file__),ROOT/'turbo.json',ROOT/'pnpm-lock.yaml',ROOT/'pnpm-workspace.yaml',ROOT/'package.json',ROOT/'hyperfide',ROOT/'contracts/host-daemon/src/hyperfide-status.vitest.config.ts']}
 report={'schema_version':1,'task':'0.8','source_revision':git('rev-parse','HEAD').decode().strip(),'status':'BLOCKED','commands':[],'assertions':[],'repairs':[]}
 env=dict(os.environ,PATH=str(NODE.parent)+os.pathsep+os.environ.get('PATH',''),COREPACK_ENABLE_NETWORK='0',CI='1',TURBO_TELEMETRY_DISABLED='1',CG=str(ROOT/'hyperfide'))
 def command(name,argv,timeout=120):
  start=time.monotonic();p=subprocess.run(argv,cwd=ROOT,env=env,text=True,capture_output=True,timeout=timeout);log=OUT/(name+'.log');log.write_text(p.stdout+p.stderr)
  report['commands'].append({'id':name,'command':list(map(str,argv)),'exit_code':p.returncode,'duration_ms':int((time.monotonic()-start)*1000),'log':str(log.relative_to(ROOT)),'log_sha256':digest(log),'inputs':inputs})
  if p.returncode:raise AssertionError(name+' exited '+str(p.returncode)+'; '+str(log.relative_to(ROOT)))
  return p.stdout
 def check(name,condition,cmd):
  if not condition:raise AssertionError(name)
  report['assertions'].append({'id':name,'status':'PASS','command_id':cmd})
 def script(name):return (ROOT/f'tests/hyperfide/cases/v22/{name}.sh').read_text()
 def python_block(text):return text.split("python3 - <<'PY'\n",1)[1].split('\nPY',1)[0]
 def turbo_calls(text):
  result=[]
  for line in text.replace('\\\n',' ').splitlines():
   if 'turbo run ' not in line:continue
   tokens=shlex.split(line,comments=True);start=tokens.index('run')+1;tasks=[]
   for token in tokens[start:]:
    if token.startswith('-') or token in {'||','&&',';'}:break
    tasks.append(token)
   filters=[t for t in tokens if t.startswith('--filter=./')]
   if filters:result.append((tasks,filters))
  return result
 try:
  expected_roots=sorted({row['destination'] for row in rules if row['source'].startswith('platform/')})
  actual_roots=json.loads(SCOPE.read_text())['roots']
  if actual_roots!=expected_roots:raise AssertionError('Explicit source domain differs from frozen original workspace ownership')
  baseline_files=git('ls-tree','-r','--name-only',baseline).decode().splitlines();original_owned={mapped(name) for name in baseline_files if name.startswith('platform/')}
  expected_types={mapped(name) for name in baseline_files if name.startswith('platform/') and re.search(r'\.(?:ts|tsx|mts|cts)$',name) and name!='platform/packages/domain/src/native-roots.ts' and (not name.startswith('platform/packages/plugin-sdk/src/') or '/__tests__/' in name or re.search(r'\.test\.[cm]?tsx?$',name))}
  current_tracked=set(git('ls-files').decode().splitlines());foreign={mapped(name) for name in baseline_files if not name.startswith('platform/')}-original_owned
  codemod=json.loads(command('codemod-owned-scope',[str(NODE),'tools/workspace/remove-typescript-comments.mjs','--list']))['files'];codemod=set(codemod)
  check('codemod.original-type-ownership-preserved',expected_types<=codemod,'codemod-owned-scope')
  check('codemod.standalone-and-original-foreign-types-excluded',not codemod.intersection(foreign) and not any(n.startswith(('core/control-plane/','core/native/','core/kvx/','contracts/fleet/','tests/hyperfide/')) for n in codemod),'codemod-owned-scope')
  identity=python_block(script('0_2'));command('identity-real-mapped-manifests',['python3','-c',identity]);check('identity.original-assertions-execute',sum(isinstance(n,ast.Assert) for n in ast.walk(ast.parse(identity)))>=sum(isinstance(n,ast.Assert) for n in ast.walk(ast.parse(python_block(originals['tests/hyperfide/cases/v22/0_2.sh'])))),'identity-real-mapped-manifests')
  telemetry=ast.parse(python_block(script('0_5')));prefix=[]
  for statement in telemetry.body:
   if isinstance(statement,ast.For):break
   prefix.append(statement)
  expression='\n'.join(ast.unparse(statement) for statement in prefix)+"\nimport json\nprint(json.dumps(tracked))\n"
  selected=set(json.loads(command('telemetry-real-git-domain',['python3','-c',expression])))
  check('telemetry.original-source-ownership-preserved',(original_owned&current_tracked)<=selected and bool(selected),'telemetry-real-git-domain')
  checks=[];seen={}
  for name in NAMES:
   filename=f'tests/hyperfide/cases/v22/{name}.sh';old=turbo_calls(originals[filename]);new=turbo_calls(script(name))
   if len(old)!=len(new):raise AssertionError(filename+': Turbo command inventory changed')
   for index,((oldtasks,oldfilters),(tasks,filters)) in enumerate(zip(old,new)):
    expected=[]
    for selected_filter in oldfilters:
     olddir='platform/'+selected_filter[len('--filter=./'):];pkg=json.loads(git('show',baseline+':'+olddir+'/package.json'));expected.append(pkg['name'])
    if tasks!=oldtasks:raise AssertionError(filename+': original task sequence changed')
    key=tuple(tasks+filters)
    if key not in seen:
     label='turbo-owner-selection-'+str(len(seen));argv=[str(PNPM),'exec','turbo','run',*tasks,*filters,'--dry=json'];observed=json.loads(command(label,argv));seen[key]=(label,observed)
    label,observed=seen[key];check('driver.'+name+'.turbo-'+str(index)+'.package-identity-selection',set(observed['packages'])==set(expected) and bool(expected),label)
    checks.append({'driver':filename,'tasks':tasks,'filters':filters,'expected_packages':expected,'actual_packages':observed['packages']})
  config_output=OUT/'status-test-files.json';command('package-internal-status-config',[str(PNPM),'-C','contracts/host-daemon','exec','vitest','list','--config','src/hyperfide-status.vitest.config.ts','--filesOnly','--json='+str(config_output)])
  check('host-daemon.package-internal-config-discovers-real-tests',bool(json.loads(config_output.read_text())),'package-internal-status-config')
  for name in re.findall(r'pnpm exec tsx (\S+)',script('6_3')):
   check('embedded.actual-tsx-entry-'+str(len(report['assertions'])),(ROOT/name).is_file(),'package-internal-status-config')
  command('closure-actual-selftest',['python3','tests/hyperfide/closure_check.py','--selftest','--json']);check('closure.original-positive-and-negative-fixtures-execute',True,'closure-actual-selftest')
  command('semantic-resolver-actual-component',['bash','tests/integration/66_sem_resolve.sh'],180);check('semantic-resolver.actual-moved-source-and-header-compile',True,'semantic-resolver-actual-component')
  for path in AFFECTED:
   name=str(path.relative_to(ROOT));original=next((row['source'] for row in rules if name==row['destination']),name);current=path.read_bytes();report['repairs'].append({'source':original,'target':name,'before_blob':git('rev-parse',baseline+':'+original).decode().strip(),'layout_blob':git('rev-parse',layout+':'+name).decode().strip(),'after_blob':hashlib.sha1(b'blob '+str(len(current)).encode()+b'\0'+current).hexdigest(),'mode':'100755' if os.stat(path).st_mode&0o111 else '100644','evidence_task':'0.8'})
  (OUT/'selection-observations.json').write_text(json.dumps({'codemod_files':sorted(codemod),'telemetry_files':sorted(selected),'turbo_calls':checks},indent=2)+'\n')
  if any(digest(ROOT/name)!=value for name,value in inputs.items()):raise AssertionError('A focused command input changed during the gate')
  report['status']='PASS'
 except Exception as error:report['error']=str(error)
 report['checked_at']=datetime.now(timezone.utc).isoformat();(OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'assertions':len(report['assertions']),'error':report.get('error')}));return 0 if report['status']=='PASS' else 1

if __name__=='__main__':sys.exit(main())
