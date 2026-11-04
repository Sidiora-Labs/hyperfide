#!/usr/bin/env python3
"""Native source crash, physical PostgreSQL failover and backup restore drill."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/cases/support'))
from postgres_cluster import PostgresCluster

def main():
    binary=Path(os.environ.get('HYPERFIDE_PG_BIN','/usr/lib/postgresql/18/bin'))
    if not (binary/'initdb').exists():raise RuntimeError('Owned PostgreSQL18 binaries required')
    output=Path(os.environ.get('HYPERFIDE_SOURCE_EVIDENCE_DIR',str(ROOT/'build/source-control/6.1'))).resolve();output.mkdir(parents=True,exist_ok=True)
    guard_env={key:value for key,value in os.environ.items() if key!='DATABASE_URL'}
    guard_env['HYPERFIDE_SOURCE_EVIDENCE_DIR']=str(output/'standalone-authority')
    guard=subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/cases/source_control/server_authority.py')],cwd=ROOT,env=guard_env,text=True,capture_output=True,timeout=300)
    (output/'standalone-authority.log').write_text(guard.stdout+guard.stderr)
    if guard.returncode:raise RuntimeError('Standalone authority guard qualification failed; see '+str(output/'standalone-authority.log'))
    sys.stdout.write(guard.stdout)
    target=output/'dist';config=output/'tsconfig.json'
    dependencies=output/'node_modules'
    if not dependencies.exists():dependencies.symlink_to(ROOT/'core/control-plane/node_modules',target_is_directory=True)
    migrations=output/'migrations'
    if not migrations.exists():migrations.symlink_to(ROOT/'core/control-plane/migrations',target_is_directory=True)
    source_files=['source_control/registration.ts','source_control/http.ts','source_control/backup.ts','source_control/recovery.ts','source_control/routing.ts','source_control/objects.ts','source_control/trees.ts','source_control/s3.ts','source_control/gc.ts','source_control/capabilities.ts','source_control/authentication.ts','storage/durability.ts','storage/runtime.ts']
    source_hashes={file:hashlib.sha256((ROOT/'core/control-plane/src'/file).read_bytes()).hexdigest() for file in source_files}
    config.write_text(json.dumps({'compilerOptions':{'target':'ES2023','module':'NodeNext','moduleResolution':'NodeNext','strict':True,'noUncheckedIndexedAccess':True,'exactOptionalPropertyTypes':True,'skipLibCheck':True,'rootDir':str(ROOT/'core/control-plane/src'),'outDir':str(target),'types':['node'],'typeRoots':[str(ROOT/'core/control-plane/node_modules/@types')]},'files':[str(ROOT/'core/control-plane/src'/file) for file in source_files]}))
    subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(config)],check=True,cwd=ROOT)
    for source in (ROOT/'core/control-plane/src').rglob('*.mjs'):
        destination=target/source.relative_to(ROOT/'core/control-plane/src');destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
    sdk=output/'sdk'
    subprocess.run([str(ROOT/'core/control-plane/node_modules/.bin/tsc'),'-p',str(ROOT/'sdk/source-control/tsconfig.json'),'--outDir',str(sdk)],check=True,cwd=ROOT)
    node=shutil.which('node');actor=ROOT/'tests/hyperfide/support/native_source_recovery_actor.mjs'
    root=Path(tempfile.mkdtemp(prefix='source-recovery-',dir='/tmp/hyperfide'));root.chmod(0o755)
    cluster=None;backend=None;checks=[];timeline=[];started=time.monotonic();state={}
    env={key:value for key,value in os.environ.items() if key!='DATABASE_URL'}
    scope={key:str(uuid.uuid4()) for key in ['organisation_id','repository_id','security_domain_id']}
    journal=root/'journal';journal.mkdir(mode=0o700)
    base={'module_root':str(target),'migrations':str(ROOT/'core/control-plane/migrations'),'scope':scope,'principal':str(uuid.uuid4()),'deployment_id':str(uuid.uuid4()),'journal_dir':str(journal),'pg_bin':str(binary),'source_epoch':'1','sdk_root':str(sdk),'remote_git':str(root/'recovery-remote.git')}
    live='--component' not in sys.argv
    if not live:
        backend=subprocess.Popen([node,'--input-type=module','-e',"import {createSourceS3Fixture} from './tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const f=await createSourceS3Fixture();console.log(JSON.stringify(f.config));process.once('SIGTERM',async()=>{await f.close();process.exit(0)});"],cwd=ROOT,stdout=subprocess.PIPE,text=True)
        if not select.select([backend.stdout],[],[],15)[0]:raise RuntimeError('Object backend did not start')
        base['backend_config']=json.loads(backend.stdout.readline())
    command=[node,*(['--env-file-if-exists='+str(ROOT/'.env')] if live else []),str(actor)]
    def invoke(mode,**values):
        request={**base,'mode':mode,**values}
        completed=subprocess.run(command,input=json.dumps(request),text=True,capture_output=True,cwd=ROOT,env=env,timeout=120)
        timeline.append({'mode':mode,'elapsed_ms':round((time.monotonic()-started)*1000),'exit_code':completed.returncode})
        if completed.returncode:raise RuntimeError(mode+': '+completed.stderr[-5000:])
        return json.loads(completed.stdout.strip().splitlines()[-1])
    def stage(phase,**values):
        request={**base,'mode':'stage','phase':phase,**values}
        child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=ROOT,env=env)
        child.stdin.write(json.dumps(request));child.stdin.close()
        if not select.select([child.stdout],[],[],60)[0]:child.kill();raise RuntimeError('Worker stage did not arrive: '+phase)
        line=child.stdout.readline()
        if not line:raise RuntimeError('Worker stage failed: '+child.stderr.read()[-4000:])
        result=json.loads(line);child.kill();child.wait(timeout=10);assert child.returncode<0
        timeline.append({'mode':'worker-death','phase':phase,'elapsed_ms':round((time.monotonic()-started)*1000),'exit_code':child.returncode})
        return result
    try:
        cluster=PostgresCluster(root/'database',bin_dir=binary)
        base['database_url']=cluster.url();base['synchronous']=False
        initial=invoke('setup');cluster.replicate();cluster.synchronous(True);base['synchronous']=True
        probe=invoke('probe')
        profile={'schema_version':1,'profile_id':'owned-pg18-s3-v1','metadata':{'failure_domain':'owned-host','evidence_digest':probe['metadata_evidence'],'acknowledgment':'SYNC_REPLICA','replica_failure_domains':['owned-host'],'supported_failures':['PROCESS_LOSS','PRIMARY_INSTANCE_LOSS']},'placements':[{'backend_id':probe['backend'],'region':probe['region'],'failure_domain':'selected-object-backend','capabilities':{'conditional_create':True,'conditional_delete':True,'strong_read_after_write':True},'evidence_digest':probe['evidence_digest']}],'backup':{'retention_seconds':3600,'maximum_age_seconds':3600,'external_journal_id':base['deployment_id']},'objectives':{'rpo_seconds':0,'rto_seconds':120}}
        invoke('profile',profile=profile)
        cluster.synchronous(False)
        for _ in range(200):
            if cluster.sql("SELECT count(*) FROM pg_stat_replication WHERE sync_state IN ('sync','quorum')")=='0':break
            time.sleep(.01)
        try:
            invoke('backup',backup={'backup_id':str(uuid.uuid4()),'profile':profile,'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(time.time()+1800))+'.000Z','max_revisions':1000,'max_objects':10000,'max_bytes':16777216})
            raise AssertionError('Required synchronous replica was inferred rather than observed')
        except RuntimeError as error:assert 'DURABILITY_NOT_READY' in str(error)
        finally:cluster.synchronous(True)
        checks.append('actual asynchronous replica state refuses the synchronous acknowledgment profile')
        rejected={**profile,'metadata':{**profile['metadata'],'supported_failures':['FAILURE_DOMAIN_LOSS']}}
        try:invoke('profile',profile=rejected);raise AssertionError('Unsupported failure domain accepted')
        except RuntimeError as error:assert 'Failure-domain loss requires a qualified external topology verifier' in str(error)
        checks.append('explicit measured profile rejects unsupported failure-domain claims')
        stage('before-verification',operation_id=str(uuid.uuid4()),text='unverified crash')
        stage('after-upload',operation_id=str(uuid.uuid4()),text='uploaded before verification crash')
        stage('after-verification',operation_id=str(uuid.uuid4()),text='verified crash')
        operation=str(uuid.uuid4());change=str(uuid.uuid4())
        committed=stage('after-commit',operation_id=operation,change_id=change,text='committed crash')
        replay=invoke('write',operation_id=operation,change_id=change,text='committed crash',root_tree_id=committed['result']['root_tree_id'])
        assert replay['revision_id']==committed['result']['revision_id']
        acknowledged=[replay['revision_id']]
        for index in range(2):acknowledged.append(invoke('write',operation_id=str(uuid.uuid4()),change_id=str(uuid.uuid4()),text='acknowledged '+str(index))['revision_id'])
        checks.append('real worker process death before verification, after verification and after commit preserves exact replay identity')
        multipart=invoke('multipart-stage') if live else None
        publication=invoke('publication-stage');acknowledged.extend(publication['revisions'])
        invoke('pending-delete',operation_id=str(uuid.uuid4()))
        backup_id=str(uuid.uuid4());backup=invoke('backup',backup={'backup_id':backup_id,'profile':profile,'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(time.time()+1800))+'.000Z','max_revisions':1000,'max_objects':10000,'max_bytes':16777216})
        assert invoke('epoch-race')['blocked'];checks.append('active source transaction holds the external epoch fence against concurrent revocation')
        acknowledged.append(invoke('write',operation_id=str(uuid.uuid4()),change_id=str(uuid.uuid4()),text='newer acknowledged inventory')['revision_id'])
        try:invoke('verify',backup_id=backup_id);raise AssertionError('Uncaptured revision inventory accepted')
        except RuntimeError as error:assert 'Restored revision inventory differs' in str(error)
        backup_id=str(uuid.uuid4());backup=invoke('backup',backup={'backup_id':backup_id,'profile':profile,'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(time.time()+1800))+'.000Z','max_revisions':1000,'max_objects':10000,'max_bytes':16777216})
        invoke('unlisted-upload')
        try:invoke('verify',backup_id=backup_id);raise AssertionError('Uncaptured external intent admitted')
        except RuntimeError as error:assert 'Uncaptured source effect' in str(error)
        checks.append('new pending effects beyond the captured recovery point are refused before readiness')
        backup_id=str(uuid.uuid4());backup=invoke('backup',backup={'backup_id':backup_id,'profile':profile,'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(time.time()+1800))+'.000Z','max_revisions':1000,'max_objects':10000,'max_bytes':16777216})
        assert invoke('verify',backup_id=backup_id)['state']=='READY'
        checks.append('backup completeness refuses acknowledged revisions outside its immutable capture')
        assert invoke('legacy-manifest',backup_id=backup_id)['code']=='BACKUP_FORMAT_UNSUPPORTED'
        checks.append('legacy backup manifests fail with a typed upgrade boundary rather than implying recovery readiness')
        try:invoke('verify',backup_id=backup_id,credential_expiry='2000-01-01T00:00:00.000Z');raise AssertionError('Expired backup credential accepted')
        except RuntimeError as error:assert 'Source authority epoch, policy or expiry changed' in str(error)
        old_id=str(uuid.uuid4());old_profile={**profile,'backup':{**profile['backup'],'maximum_age_seconds':1}}
        invoke('backup',backup={'backup_id':old_id,'profile':old_profile,'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(time.time()+1800))+'.000Z','max_revisions':1000,'max_objects':10000,'max_bytes':16777216});time.sleep(1.1)
        try:invoke('verify',backup_id=old_id);raise AssertionError('Overage backup accepted')
        except RuntimeError as error:assert 'Backup exceeds the declared recovery age' in str(error)
        checks.append('stale backup credentials and overage snapshots fail before verification')
        physical=cluster.backup();old_primary=cluster.primary;old_socket=cluster.socket
        crash=time.monotonic();cluster.stop(old_primary);cluster.promote();base['database_url']=cluster.url(replica=True);base['synchronous']=False
        assert set(acknowledged)<=set(row['revision_id'] for row in invoke('inventory'))
        checks.append('physical synchronous PostgreSQL failover preserves every acknowledged native revision')
        cluster.stop(cluster.standby);old_standby=cluster.standby;old_replica_socket=cluster.replica_socket
        restored=root/'database'/'restored';shutil.copytree(physical,restored)
        uid=pwd.getpwnam('postgres');restored_socket=root/'database'/'restored-socket';restored_socket.mkdir();os.chown(restored_socket,uid.pw_uid,uid.pw_gid)
        for directory,dirs,files in os.walk(restored):
            os.chown(directory,uid.pw_uid,uid.pw_gid)
            for filename in files:os.chown(Path(directory)/filename,uid.pw_uid,uid.pw_gid)
        cluster.configure(restored,restored_socket);cluster.start(restored)
        cluster.primary=restored;cluster.socket=restored_socket;cluster.standby=root/'database'/'restored-standby';cluster.replica_socket=root/'database'/'restored-replica-socket';cluster.replica_socket.mkdir();os.chown(cluster.replica_socket,uid.pw_uid,uid.pw_gid)
        cluster.replicate();cluster.synchronous(True);base['database_url']=cluster.url();base['synchronous']=True
        assert set(acknowledged)<=set(row['revision_id'] for row in invoke('inventory'))
        activation_id=str(uuid.uuid4());restoration=invoke('restore',operation_id=activation_id,external_epoch=initial['external_epoch'],database_epoch=initial['external_epoch'],backup_id=backup_id,old_writers=[{'directory':str(old_primary),'socket':str(old_socket/('.s.PGSQL.'+str(cluster.port)))},{'directory':str(old_standby),'socket':str(old_replica_socket/('.s.PGSQL.'+str(cluster.port)))}])
        assert invoke('object-gate')['code']=='RECOVERY_NOT_READY'
        invoke('prepare',request=restoration['request'])
        try:invoke('reconcile',request={'backup_id':backup_id,'operation_id':str(uuid.uuid4()),'limit':1});raise AssertionError('Foreign recovery operation admitted')
        except RuntimeError as error:assert 'current prepared restore' in str(error)
        try:invoke('reconcile',request={'backup_id':backup_id,'operation_id':activation_id,'limit':1},credential_expiry='2000-01-01T00:00:00.000Z');raise AssertionError('Expired reconciliation credential admitted')
        except RuntimeError as error:assert 'Source authority epoch, policy or expiry changed' in str(error)
        checks.append('effect reconciliation refuses another restore operation and expired authority')
        copied=root/'missing-object.bin';invoke('remove-object',backup_id=backup_id,object_copy=str(copied),object_id=publication['evidence_object_id']);missing=invoke('verify',backup_id=backup_id);assert missing['state']=='FAILED' and missing['failure_code']=='OBJECT_MISSING_OR_CORRUPT'
        try:invoke('activate',request=restoration['request']);raise AssertionError('Incomplete restore became writable')
        except RuntimeError as error:assert 'Verified unexpired backup required' in str(error)
        try:invoke('write',operation_id=str(uuid.uuid4()),change_id=str(uuid.uuid4()),root_tree_id=backup['manifest']['revisions'][0]['root_tree_id']);raise AssertionError('Recovery write barrier bypassed')
        except RuntimeError as error:assert 'Source mutation is fenced' in str(error)
        assert invoke('object-gate')['code']=='RECOVERY_NOT_READY'
        checks.append('fresh restore rechecks actual object bytes and refuses mutation readiness when a referenced object is missing')
        invoke('restore-object',backup_id=backup_id,object_copy=str(copied),object_id=publication['evidence_object_id']);assert invoke('verify',backup_id=backup_id)['state']=='READY'
        try:invoke('activate',request=restoration['request']);raise AssertionError('Unreconciled effects admitted')
        except RuntimeError as error:assert 'Captured source effects require reconciliation' in str(error)
        uncertain=invoke('reconcile',request={'backup_id':backup_id,'operation_id':activation_id,'limit':128},hide_remote=True,hide_abort=True);assert uncertain['remaining_effects']>0
        if live:assert uncertain['remaining_effects']>=2 and any(row['kind']=='UPLOAD' and row['status']=='UNKNOWN' for row in uncertain['outcomes'])
        before_replay=invoke('backup-read',backup_id=backup_id);invoke('prepare',request=restoration['request']);after_replay=invoke('backup-read',backup_id=backup_id);assert before_replay['pending_effects']==after_replay['pending_effects'] and before_replay['effect_count']==after_replay['effect_count']
        checks.append('preparation replay preserves already resolved effects and the remaining recovery debt')
        try:invoke('activate',request=restoration['request']);raise AssertionError('Unknown issued export admitted')
        except RuntimeError as error:assert 'Captured source effects require reconciliation' in str(error)
        reconciled=invoke('reconcile',request={'backup_id':backup_id,'operation_id':activation_id,'limit':128});assert reconciled['remaining_effects']==0
        if live:
            assert invoke('multipart-absent',multipart=multipart)['aborted']
            checks.append('actual multipart abort with a lost acknowledgment stays pending until exact-session reconciliation proves absence')
        assert any(row['kind']=='UPLOAD' for row in uncertain['outcomes']) and any(row['kind']=='DELETE' for row in uncertain['outcomes']) and any(row['kind']=='PUBLICATION' for row in reconciled['outcomes'])
        checks.append('fresh restore reconciles captured S3 upload and deletion outcomes and actual issued Git publication before reopening writes')
        activation=invoke('activate',request=restoration['request']);assert activation['source_epoch']=='2'
        effects=invoke('effect-inventory',publication=publication);assert effects['publication']['status']=='PUBLISHED' and effects['publication']['git_oid']==publication['git_oid']==effects['remote'] and effects['acceptance_digest']==publication['acceptance_digest']
        checks.append('independent accepted-source receipt and actual Git head survive restore and reconcile without another push')
        recovery_seconds=round(time.monotonic()-crash,3);assert recovery_seconds<=profile['objectives']['rto_seconds']
        try:invoke('write',operation_id=str(uuid.uuid4()),change_id=str(uuid.uuid4()),text='stale writer',root_tree_id=backup['manifest']['revisions'][0]['root_tree_id']);raise AssertionError('Old source authority admitted')
        except RuntimeError as error:assert 'Old source writer is fenced' in str(error)
        checks.append('existing external authority journal fences stopped prior writers and source activation rejects old authority')
        base['source_epoch']='2';assert set(acknowledged)<=set(row['revision_id'] for row in invoke('inventory'))
        assert invoke('routing')['old_writer_refused'];checks.append('live partition owner movement preserves reads and fences old upload completion')
        assert invoke('delayed-delete')['preserved'];checks.append('delayed old deletion preserves the fresh incarnation in the selected object backend')
        cleanup=invoke('cleanup');assert cleanup['unresolved']==[]
        receipt={'status':'PASS','scope':'owned PostgreSQL18 physical failover and restore; '+('configured live S3 backend' if live else 'signed HTTP S3 fixture'),'checks':checks,'acknowledged_revisions':acknowledged,'backup_manifest_digest':backup['manifest_digest'],'source_epoch':activation['source_epoch'],'external_epoch':activation['external_epoch'],'elapsed_seconds':round(time.monotonic()-started,3),'failover_restore_seconds':recovery_seconds,'profile':profile,'postgres_version':probe['postgres_version'],'migrations':probe['migrations'],'source_hashes':source_hashes,'fault_schedule':timeline,'object_cleanup':cleanup}
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
        return 0
    finally:
        if cluster:
            if live:
                try:invoke('cleanup')
                except Exception as error:(output/'cleanup-debt.json').write_text(json.dumps({'status':'UNKNOWN','message':str(error)},indent=2)+'\n')
            clean=cluster.close()
            if not clean:raise RuntimeError('Owned PostgreSQL cleanup remains incomplete')
        if backend:
            backend.terminate()
            try:backend.wait(timeout=10)
            except subprocess.TimeoutExpired:backend.kill();backend.wait()
        shutil.rmtree(root,ignore_errors=True)

if __name__=='__main__':raise SystemExit(main())
