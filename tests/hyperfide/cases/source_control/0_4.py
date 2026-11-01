#!/usr/bin/env python3
"""Qualify root workspace relocation at public package-manager and CLI boundaries.

Protects dependency conservation and workspace selection after category moves;
uses actual pnpm/Turbo rather than copied predicates or a simulated resolver.
Historical logs without source/input pins cannot qualify installation or builds.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import time
try:
    import yaml
except ImportError:
    yaml=None

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/layout/0.4'
PACK = ROOT / 'spec/hyperfide-source-control'
SELF = Path(__file__).resolve()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def mapping():
    return json.loads((PACK / 'repository-layout.json').read_text())


def mapped(path):
    path=posixpath.normpath(path)
    rules = [r for r in mapping()['mappings'] if path == r['source'] or path.startswith(r['source'].rstrip('/') + '/')]
    if not rules:
        return path
    rule = max(rules, key=lambda r: len(r['source']))
    return (rule['destination'].rstrip('/') + path[len(rule['source']):]).lstrip('/')


def execute(argv, cwd=ROOT, timeout=90):
    result = subprocess.run([str(a) for a in argv], cwd=cwd, env=os.environ, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(json.dumps({'command':[str(a) for a in argv], 'exit_code':result.returncode, 'stderr':result.stderr[-2400:]}))
    return result.stdout


def workspace():
    values = json.loads(execute(['pnpm','list','-r','--depth','-1','--json']))
    return {Path(v['path']).relative_to(ROOT).as_posix():v for v in values if Path(v['path']) != ROOT}


def lock():
    if yaml is None:raise FileNotFoundError('CAPABILITY_MISSING: PyYAML lockfile parser')
    return yaml.safe_load((ROOT / 'pnpm-lock.yaml').read_text())


def baseline_lock():
    if yaml is None:raise FileNotFoundError('CAPABILITY_MISSING: PyYAML lockfile parser')
    revision = mapping()['implementation_baseline']
    return yaml.safe_load(git('show', revision + ':platform/pnpm-lock.yaml'))


def membership():
    actual = workspace()
    importers = {p for p in lock()['importers'] if p != '.'}
    if set(actual) != importers:
        raise AssertionError({'workspace_not_lock':sorted(set(actual)-importers),'lock_not_workspace':sorted(importers-set(actual))})
    for path, entry in actual.items():
        manifest = json.loads((ROOT/path/'package.json').read_text())
        if entry['name'] != manifest.get('name'):
            raise AssertionError('Package-manager identity differs: '+path)
    forbidden = ['core/control-plane','core/kvx']
    if any(p in actual or any(k.startswith(p+'/') for k in actual) for p in forbidden) or any(p.startswith('extensions/') for p in actual):
        raise AssertionError('Standalone boundary was absorbed into pnpm')
    if (ROOT/'platform/pnpm-lock.yaml').exists() or (ROOT/'platform/pnpm-workspace.yaml').exists():
        raise AssertionError('Second authoritative pnpm workspace remains')
    package = json.loads((ROOT/'package.json').read_text())
    if execute(['pnpm','--version']).strip()!='9.15.0':raise FileNotFoundError('CAPABILITY_MISSING: selected pnpm9.15.0 runtime')
    if package.get('packageManager') != 'pnpm@9.15.0':
        raise AssertionError('Pinned pnpm profile changed')
    declared=(ROOT/'.nvmrc').read_text().strip()
    actual_node=execute(['node','--version']).strip()
    if actual_node!='v'+declared:raise FileNotFoundError('CAPABILITY_MISSING: declared Node22 development profile '+declared)
    node24=Path(os.environ.get('HYPERFIDE_LAYOUT_NODE24','/root/.nvm/versions/node/v24.22.0/bin/node'))
    if not node24.is_file():raise FileNotFoundError('CAPABILITY_MISSING: selected Node24 control profile')
    print(json.dumps({'packages':len(actual),'importers':len(importers),'standalone_exclusions':forbidden+['extensions/**'],'pnpm':execute(['pnpm','--version']).strip(),'development_node':{'declared':declared,'observed':actual_node},'control_node':{'engines':json.loads((ROOT/'core/control-plane/package.json').read_text()).get('engines'),'observed':execute([node24,'--version']).strip(),'installation_qualified':False}}))


def normalize_dependencies(value, importer, old=False):
    value = json.loads(json.dumps(value))
    for kind in ['dependencies','devDependencies','optionalDependencies']:
        for item in value.get(kind,{}).values():
            if isinstance(item,dict) and isinstance(item.get('version'),str) and item['version'].startswith('link:'):
                target = posixpath.normpath(posixpath.join(importer,item['version'][5:]))
                if old:
                    target = posixpath.dirname(mapped('platform/'+target+'/package.json'))
                item['version']='workspace-path:'+target
    return value


def dependencies():
    before, after = baseline_lock(), lock()
    errors=[]
    for package, pin in before.get('patchedDependencies',{}).items():
        current=after.get('patchedDependencies',{}).get(package,{})
        old_path=posixpath.normpath('platform/'+pin['path'])
        new_path=mapped(old_path)
        original=subprocess.check_output(['git','show',mapping()['implementation_baseline']+':'+old_path],cwd=ROOT)
        if current.get('hash')!=pin.get('hash') or current.get('path')!=new_path or (ROOT/new_path).read_bytes()!=original:
            errors.append('Authored patch identity changed: '+package)
    for field in ['lockfileVersion','packages','snapshots']:
        if before.get(field) != after.get(field):
            errors.append('External dependency resolution section changed: '+field)
    expected={}
    for old, value in before['importers'].items():
        target = posixpath.dirname(mapped('platform/'+('' if old=='.' else old+'/')+'package.json')) or '.'
        expected[target]=normalize_dependencies(value,old,True)
    current={p:normalize_dependencies(v,p) for p,v in after['importers'].items()}
    if expected != current:
        errors.extend('Importer changed: '+p for p in sorted(set(expected)|set(current)) if expected.get(p)!=current.get(p))
    baseline=json.loads((ROOT/'build/layout/0.3/inventory.json').read_text())
    checked=0
    for entry in baseline['packages']:
        target=ROOT/entry['target']
        if entry['source'].startswith('platform/') and target.is_file():
            current_package=json.loads(target.read_text())
            if current_package.get('name') != entry.get('name'):
                errors.append('Public package name changed: '+entry['target'])
            def manifest_refs(values, directory, old):
                result={}
                for name, spec in values.items():
                    if isinstance(spec,str) and spec.startswith(('file:','link:')):
                        target=posixpath.normpath(posixpath.join(directory,spec.split(':',1)[1]))
                        spec='path:'+(mapped(target) if old else target)
                    result[name]=spec
                return result
            for kind, previous in entry.get('dependency_identities',{}).items():
                if manifest_refs(previous,posixpath.dirname(entry['source']),True)!=manifest_refs(current_package.get(kind,{}),posixpath.dirname(entry['target']),False):
                    errors.append('Authored manifest dependency changed: '+entry['target']+':'+kind)

            checked+=1
    if errors:
        raise AssertionError(errors[:40])
    print(json.dumps({'baseline_revision':mapping()['implementation_baseline'],'preserved_importers':len(expected),'preserved_package_names':checked,'external_packages':len(after.get('packages',{}))}))


def discovery():
    expected=str(ROOT/'node_modules')
    for cwd in [ROOT,ROOT/'apps/web',ROOT/'tools/workspace']:
        if execute(['pnpm','root','-w'],cwd).strip()!=expected:
            raise AssertionError('Nested pnpm root discovery differs: '+str(cwd))
    entry=ROOT/'apps/cli/bin/hyperfide-platform'
    if not (ROOT/'apps/cli/dist/index.js').is_file():
        raise FileNotFoundError('CAPABILITY_MISSING: built CLI; automatic build deliberately refused')
    outputs=[]
    for cwd in [ROOT,ROOT/'apps/web']:
        outputs.append(execute(['node',entry,'--help'],cwd))
    if outputs[0]!=outputs[1] or 'hyperfide-platform' not in outputs[0]:
        raise AssertionError('Root/nested public CLI discovery differs')
    output=execute(['node',entry,'--help'],ROOT/'tools/workspace')
    if output!=outputs[0]:
        raise AssertionError('Moved tools CLI invocation differs')
    override_env={**os.environ,'HYPERFIDE_CLI':str(entry)}
    overridden=subprocess.run(['node',str(entry),'--help'],cwd=ROOT/'apps/web',env=override_env,capture_output=True,text=True,timeout=90)
    if overridden.returncode or overridden.stdout!=outputs[0]:raise AssertionError('Explicit CLI self override changes nested discovery')
    for hook in [ROOT/'.hyperfide-env-setup.sh',ROOT/'tools/workspace/env-setup.sh']:
        execute(['sh','-n',hook])
    print(json.dumps({'pnpm_root_contexts':3,'cli_help_contexts':3,'cli_help_sha256':hashlib.sha256(output.encode()).hexdigest(),'hook_shell_parse':True,'explicit_self_override':True,'installed_release_discovery':'NOT_QUALIFIED_BY_SOURCE_CLI'}))


def cache():
    packages=workspace()
    selected=next((p for p,v in packages.items() if v['name']=='@hyperfide/process-utils'),None)
    if not selected:
        raise FileNotFoundError('CAPABILITY_MISSING: moved process-utils package')
    source=next(iter(sorted((ROOT/selected/'src').glob('*.ts'))),None)
    if source is None:
        raise FileNotFoundError('CAPABILITY_MISSING: moved authored build input')
    turbo=ROOT/'node_modules/.bin/turbo'
    with tempfile.TemporaryDirectory(prefix='hyperfide-layout-cache-') as directory:
        stage=Path(directory)
        for name in ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','turbo.json']:
            shutil.copyfile(ROOT/name,stage/name)
        for path in packages:
            (stage/path).mkdir(parents=True,exist_ok=True)
            shutil.copyfile(ROOT/path/'package.json',stage/path/'package.json')
        target=stage/source.relative_to(ROOT)
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target)
        def task_hash():
            result=json.loads(execute([turbo,'run','build','--filter=@hyperfide/process-utils','--dry=json'],stage))
            task=next(t for t in result['tasks'] if t['taskId']=='@hyperfide/process-utils#build')
            return task['hash']
        cold=task_hash();warm=task_hash()
        target.write_bytes(target.read_bytes()+b'\n// owned cache key qualification input\n')
        changed=task_hash()
        if cold!=warm or changed==cold:
            raise AssertionError('Turbo cache key does not track moved authored input')
        print(json.dumps({'scope':'actual Turbo dry-run cache-key engine over isolated current workspace manifests; no build execution','moved_input':source.relative_to(ROOT).as_posix(),'cold':cold,'warm':warm,'changed':changed,'source_sha256':sha(source)}))


def layout_bindings():
    filename=SELF.with_name('0_9.py')
    spec=importlib.util.spec_from_file_location('layout_receipt_bindings',filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.capture_bindings()


def consume_evidence(path,bindings):
    if not path.is_file():
        raise FileNotFoundError('EVIDENCE_MISSING: current pinned frozen-install/build evidence manifest '+str(path.relative_to(ROOT)))
    manifest=json.loads(path.read_text())
    accepted=[]
    capability_refs=manifest.get('capability_receipts',[])
    if not isinstance(capability_refs,list) or len(capability_refs)>16:raise ValueError('EVIDENCE_INVALID: bounded capability receipt references required')
    references=[('pinned-frozen-install',manifest.get('pinned-frozen-install')),('workspace-build',manifest.get('workspace-build'))]+[('capability:'+str(index),reference) for index,reference in enumerate(capability_refs)]
    for kind, reference in references:
        if not isinstance(reference,str) or reference.startswith('/') or '..' in Path(reference).parts:
            raise ValueError('EVIDENCE_MISSING: repository-relative '+kind+' receipt reference')
        file=ROOT/reference
        receipt=json.loads(file.read_text())
        for key in ['mapping_sha256','layout_generation','source_snapshot_sha256','source_snapshot']:
            if receipt.get(key)!=bindings[key]:
                raise ValueError('EVIDENCE_STALE: '+kind+' '+key)
        revision=receipt.get('source_revision')
        if not isinstance(revision,str) or subprocess.run(['git','merge-base','--is-ancestor',revision,bindings['source_revision']],cwd=ROOT,capture_output=True).returncode:
            raise ValueError('EVIDENCE_STALE: qualifying revision is not a real ancestor '+kind)
        if receipt.get('source_tree_id')!=git('rev-parse',revision+'^{tree}'):
            raise ValueError('EVIDENCE_STALE: qualifying Git tree '+kind)
        if receipt.get('status')!='PASS' or not receipt.get('commands'):
            raise ValueError('EVIDENCE_INCOMPLETE: '+kind)
        for command in receipt['commands']:
            if command.get('exit_code')!=0 or not isinstance(command.get('command'),list) or not command['command'] or not isinstance(command.get('duration_ms'),int) or command['duration_ms']<0:
                raise ValueError('EVIDENCE_INCOMPLETE: executed command identity '+kind)
            log=ROOT/command['log']
            if not log.resolve().is_relative_to(ROOT) or sha(log)!=command.get('log_sha256'):
                raise ValueError('EVIDENCE_STALE: command log '+kind)
            if not command.get('inputs') or any(not (ROOT/key).resolve().is_relative_to(ROOT) or sha(ROOT/key)!=value for key,value in command['inputs'].items()):
                raise ValueError('EVIDENCE_STALE: command inputs '+kind)
        if kind=='pinned-frozen-install' and not any('--frozen-lockfile' in c['command'] and '--lockfile-only' not in c['command'] for c in receipt['commands']):
            raise ValueError('EVIDENCE_INSUFFICIENT: lockfile-only validation does not establish actual frozen installation')
        accepted.append({'kind':kind,'path':reference,'sha256':sha(file),'commands':receipt['commands'],'assertions':receipt.get('assertions',[])})
    return accepted


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe',choices=['membership','dependencies','discovery','cache'])
    parser.add_argument('--evidence',type=Path,default=OUT/'inputs.json')
    args=parser.parse_args()
    if args.probe:
        globals()[args.probe]()
        return 0
    OUT.mkdir(parents=True,exist_ok=True)
    pinned=Path(os.environ.get('HYPERFIDE_LAYOUT_NODE22','/root/.nvm/versions/node/v'+(ROOT/'.nvmrc').read_text().strip()+'/bin/node'))
    if pinned.is_file():os.environ['PATH']=str(pinned.parent)+os.pathsep+os.environ.get('PATH','')
    bindings=layout_bindings()
    report={'schema_version':1,'task':'0.4','status':'BLOCKED',**bindings,'commands':[],'assertions':[],'artifacts':[],'missing_evidence':[],'regressions':[],'evidence_scope':'current root workspace behavior; complete qualification requires current pinned install/build and discovery evidence'}
    inputs={str(p.relative_to(ROOT)):sha(p) for p in [SELF,SELF.with_name('0_9.py'),ROOT/'package.json',ROOT/'pnpm-workspace.yaml',ROOT/'pnpm-lock.yaml',ROOT/'turbo.json',ROOT/'.nvmrc',ROOT/'core/control-plane/package.json',ROOT/'.hyperfide-env-setup.sh',ROOT/'tools/workspace/env-setup.sh',PACK/'repository-layout.json',ROOT/'build/layout/0.3/inventory.json']}
    ids={'membership':'root-workspace-membership','dependencies':'dependency-resolution-conservation','discovery':'root-nested-discovery','cache':'moved-build-input-cache-invalidation'}
    for probe,ident in ids.items():
        argv=[sys.executable,str(SELF),'--probe',probe]
        started=time.monotonic()
        result=subprocess.run(argv,cwd=ROOT,capture_output=True,text=True,timeout=240)
        log=OUT/(probe+'.log');log.write_text(result.stdout+result.stderr)
        command={'id':probe,'command':argv,'exit_code':result.returncode,'duration_ms':int((time.monotonic()-started)*1000),'log':str(log.relative_to(ROOT)),'log_sha256':sha(log),'inputs':inputs}
        report['commands'].append(command)
        if result.returncode==0:
            report['assertions'].append({'id':ident,'status':'PASS','command_id':probe})
            if probe=='membership':report['assertions'].append({'id':'legacy-stub-removal','status':'PASS','command_id':probe})
        elif 'CAPABILITY_MISSING:' in result.stderr:
            report['missing_evidence'].append({'code':'CAPABILITY_MISSING','probe':probe,'log':command['log']})
        else:
            report['regressions'].append({'code':'OBSERVED_CONTRACT_FAILURE','probe':probe,'log':command['log']})
    try:
        accepted=consume_evidence(args.evidence,bindings)
        capabilities=set()
        for entry in accepted:
            report['artifacts'].append({'path':entry['path'],'sha256':entry['sha256']})
            for command in entry['commands']:
                copied={**command,'id':entry['kind']+':'+command['id']};report['commands'].append(copied)
            command_ids={command['id'] for command in entry['commands']}
            for assertion in entry['assertions']:
                if assertion.get('status')=='PASS' and assertion.get('command_id') in command_ids:capabilities.add(assertion.get('id'))
            if entry['kind']=='pinned-frozen-install':
                report['assertions'].append({'id':'pinned-frozen-install','status':'PASS','command_id':entry['kind']+':'+entry['commands'][0]['id']})
        for capability in ['installed-cli-discovery','environment-hook-delegation','setup-input-hash-invalidation']:
            if capability not in capabilities:report['missing_evidence'].append({'code':'CAPABILITY_EVIDENCE_MISSING','capability':capability})
    except (OSError,ValueError,KeyError) as error:
        report['missing_evidence'].append({'code':'PINNED_EVIDENCE_UNAVAILABLE','detail':str(error)})
    if report['regressions']:report['status']='FAIL'
    elif not report['missing_evidence']:report['status']='PASS'
    if layout_bindings()['source_snapshot_sha256']!=bindings['source_snapshot_sha256']:
        report['status']='BLOCKED';report['missing_evidence'].append({'code':'SOURCE_INPUTS_CHANGED_DURING_DRIVER'})
    (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'receipt':str((OUT/'receipt.json').relative_to(ROOT)),'assertions':len(report['assertions']),'missing_evidence':report['missing_evidence'],'regressions':report['regressions']}))
    return {'PASS':0,'FAIL':1,'BLOCKED':2}[report['status']]

if __name__=='__main__':
    raise SystemExit(main())
