#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[4]
UID=61941
WORKER=61942

def main():
    if os.geteuid()!=0:
        raise SystemExit(77)
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            values=(entry/'status').read_text().split('Uid:',1)[1].splitlines()[0].split()
            if any(int(value) in (UID,WORKER) for value in values):
                raise RuntimeError('Dedicated test UID already active')
        except (FileNotFoundError,ProcessLookupError):
            pass
    with tempfile.TemporaryDirectory(prefix='hyperfide-parent-',dir='/var/tmp') as temporary:
        base=Path(temporary)
        base.chmod(0o711)
        native=ROOT/'core/native/src/hyperfide'
        source=(native/'preparation_stage.c').read_text()
        baseline=base/'before.c'
        baseline.write_text(source.replace(' if(!isolation_workspace_parent(stage,root))goto done;',''))
        def compile_binary(name,stage):
            binary=base/name
            subprocess.run(['cc','-std=gnu11','-ffunction-sections','-fdata-sections','-I'+str(native),'-I'+str(ROOT/'core/native/src'),'-I'+str(ROOT/'vendor/tree-sitter/lib/include'),str(ROOT/'tests/hyperfide/cases/source_control/support/fleet_parent_finalizer.c'),str(stage),str(native/'transport.c'),str(native/'supervisor.c'),'-Wl,--gc-sections','-lcrypto','-lcurl','-lsqlite3','-lpthread','-o',str(binary)],check=True,capture_output=True)
            return binary
        before=compile_binary('before',baseline)
        current=compile_binary('current',native/'preparation_stage.c')
        checks=[]
        def case(name,binary,expected,mutation=None):
            directory=base/name
            directory.mkdir(mode=0o711)
            stage=directory/'stage'
            stage.mkdir(mode=0o700)
            parent=directory/'parent'
            parent.mkdir(mode=0o700)
            os.chown(parent,UID,UID)
            root=parent/'workspace'
            root.mkdir(mode=0o700)
            os.chown(root,UID,UID)
            worker=root/'workers'/'0'
            slots={'slot':0,'worker_slot_id':str(uuid.uuid4()),'slot_generation':'1','uid':WORKER,'gid':WORKER,'worker_root':str(worker)}
            for key in ('source','home','build','temporary','dirty'):
                target=worker/key
                target.mkdir(parents=True,mode=0o700)
                slots[key]=str(target)
            for path in root.rglob('*'):
                os.chown(path,UID,UID)
                path.chmod(0o700)
            (worker/'source'/'actual.txt').write_text('actual worker file')
            os.chown(worker/'source'/'actual.txt',UID,UID)
            (worker/'source'/'actual.txt').chmod(0o600)
            operation=str(uuid.uuid4())
            digest='sha256:'+'a'*64
            admission={key:digest for key in ('admission_digest','package_digest','source_config_digest','plan_digest','source_revision','source_manifest_digest','authority_epoch')}
            admission.update(operation_id=operation,environment_id='parent-regression',environment_generation=2,environment_root=str(root),input_digest=digest,sandbox_id=str(uuid.uuid4()),boot_id=str(uuid.uuid4()),boot_generation='1',slot_bindings=[slots])
            receipt={key:value for key,value in admission.items() if key not in ('slot_bindings','environment_root')}
            receipt.update(kind='hyperfide.fleet-install-receipt',receipt_digest=digest,prepared_root=str(root),slots=[{key:value for key,value in slots.items() if key in ('slot','worker_slot_id','source','home','build','temporary','dirty')}])
            manifest={'kind':'hyperfide.fleet-install-bootstrap','admission':admission}
            stage_parent=parent
            stage_root=root
            if mutation:
                stage_parent,stage_root=mutation(parent,root)
            payload=json.dumps(manifest).encode()
            artifact=stage/'artifact-064'
            artifact.write_bytes(payload)
            os.chown(artifact,0,UID)
            artifact.chmod(0o440)
            claim=directory/'claim.json'
            claim.write_text(json.dumps({'operation_id':operation,'plan':{'preparation':{'input_manifest_digest':'sha256:'+hashlib.sha256(payload).hexdigest(),'job_binding':{'namespace':'FLEET_INSTALL','job_id':operation}}}}))
            prepared=directory/'prepared.json'
            prepared.write_text(json.dumps({'state':'PREPARED','receipt':receipt}))
            subprocess.run([str(binary),str(stage),str(stage_parent),str(stage_root),str(claim),str(prepared),str(int(expected))],check=True,capture_output=True)
            if expected:
                assert parent.stat().st_uid==0 and parent.stat().st_mode&0o777==0o711
                assert worker.stat().st_uid==0 and worker.stat().st_mode&0o777==0o710
                result=subprocess.run(['cat',str(worker/'source'/'actual.txt')],user=WORKER,group=WORKER,extra_groups=[],capture_output=True,text=True)
                assert result.returncode==0 and result.stdout=='actual worker file'
            checks.append(name)
        case('before-private-parent-rejected',before,False)
        case('private-parent-finalizes',current,True)
        def promoted(parent,root):
            os.chown(parent,0,0)
            parent.chmod(0o711)
            return parent,root
        case('already-promoted-parent',current,True,promoted)
        def partial(parent,root):
            os.chown(parent,0,0)
            return parent,root
        case('partial-chown-recovers',current,True,partial)
        def foreign(parent,root):
            os.chown(parent,WORKER,WORKER)
            return parent,root
        case('foreign-parent-rejected',current,False,foreign)
        def symlink(parent,root):
            actual=parent.parent/'actual-parent'
            parent.rename(actual)
            parent.symlink_to(actual,target_is_directory=True)
            return parent,root
        case('symlink-parent-rejected',current,False,symlink)
        case('different-stage-leaf-rejected',current,False,lambda parent,root:(parent,parent/'other'))
        out=ROOT/'build/fleet/workspace-parent'
        out.mkdir(parents=True,exist_ok=True)
        (out/'receipt.json').write_text(json.dumps({'status':'PASS','scope':'native-finalizer-private-parent-transition','checks':checks},indent=2)+'\n')
        print(json.dumps({'status':'PASS','checks':checks}))

if __name__=='__main__':
    main()
