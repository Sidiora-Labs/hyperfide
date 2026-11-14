#!/usr/bin/env python3
"""Validate the packaged native source release and explicit operator acceptance."""
import argparse
import datetime as dt
import importlib.util
import json
import os
import copy
import re
import selectors
import subprocess
import sys
import tarfile
import time
from pathlib import Path
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('release_source_closure',ROOT/'tests/hyperfide/source-control/closure.py')
closure=importlib.util.module_from_spec(spec);spec.loader.exec_module(closure)
ROLES={'service','host','native','cli','sdk'}
OUT=ROOT/'build/source-control/7.2'
CLASS_VARIANTS={
    'live_backend':{('SCM-002','real-s3'),('SCM-022','real-s3-72h')},
    'live_fleet':{('SCM-014','hyperfide-fleet'),('SCM-022','real-worker'),('SCM-023','api-cli-ui')},
    'github':{('SCM-015','github')},
    'consolidation':{('SCM-017','cutover')},
    'growth':{('SCM-020','growth'),('SCM-021','mixed-load'),('SCM-021','open-admission')},
    'recovery':{('SCM-018','metadata-failover'),('SCM-019','restore')},
}
RUNTIME_CHECKS={'packaged-service-ready','fleet-custody-current','accepted-roots-readback',
                'sparse-durable-checkpoint','ambiguous-publication-once','postgres-object-metadata-restore',
                'restored-roots-reconciled','packaged-service-stopped'}


def evidence_inventory(manifest):
    classes=manifest['evidence_classes']
    required={'component',*CLASS_VARIANTS}
    closure.require(isinstance(classes,dict) and set(classes)==required,'Missing required evidence class or unknown evidence class')
    for name,records in classes.items():
        closure.require(isinstance(records,list) and records,'Missing required evidence class: '+name)
        if name=='component':continue
        keys=[]
        for record in records:
            closure.require(isinstance(record,dict) and set(record)=={'case_id','variant','receipt_id','receipt_sha256'},'Exact evidence class reference required: '+name)
            keys.append((record['case_id'],record['variant']))
        closure.require(len(set(keys))==len(keys) and set(keys)==CLASS_VARIANTS[name],'Evidence class variant inventory differs: '+name)
    return classes


def verify_custody(source,observed):
    closure.require(isinstance(observed,dict),'Current custody observation required')
    closure.require({'custody_id','current_custody_id','custody_generation','qualified_custody_generation','qualification_id','current_qualification_id','revoked_at'}<=set(observed),'Stale custody: missing current binding')
    closure.require(isinstance(observed['custody_id'],str) and str(uuid.UUID(observed['custody_id']))==observed['custody_id'] and isinstance(observed['qualification_id'],str) and bool(observed['qualification_id']),'Stale custody: explicit custody and qualification required')
    closure.require(observed.get('authority')=='ACTIVE' and observed.get('revoked_at') is None
                    and observed.get('qualification_outcome')=='PASS'
                    and observed.get('current_custody_id')==observed.get('custody_id')
                    and observed.get('current_qualification_id')==observed.get('qualification_id')
                    and isinstance(observed.get('custody_generation'),str)
                    and re.fullmatch('[1-9][0-9]*',observed['custody_generation']) is not None
                    and observed.get('custody_generation')==observed.get('qualified_custody_generation')
                    and all(observed.get(key)==source[key] for key in ('scope','revision_id','root_tree_id','authority_epoch','policy_version')),
                    'Stale custody: current source, generation, authority and qualification must match')


def verify_evidence_classes(base,manifest,checked):
    classes=evidence_inventory(manifest)
    verified={(row['case_id'],row['variant']):row for row in checked}
    result={}
    for name,records in classes.items():
        result[name]=[]
        for record in records:
            if name=='component':
                path=pin(base,record);receipt=closure.load(path)
                closure.require(receipt.get('status')=='PASS' and receipt.get('scope')=='packaged native source component','Passing packaged component receipt required')
                closure.require(receipt.get('artifact_sha256') in {a['sha256'] for a in manifest['artifacts']},'Component receipt artifact is stale')
                closure.require(receipt.get('checks') and receipt.get('documented_commands'),'Component receipt lacks executed checks')
                package=closure.load(pin(base,manifest['runtime']['package_manifest']))
                closure.require(receipt.get('source_inputs_sha256')==package['source_inputs_sha256'],'Component receipt source inputs are stale')
                for command in receipt['documented_commands']:
                    closure.require(type(command.get('exit_code')) is int and command['exit_code']==0,'Component documented command failed')
                    log=closure.path_from(path.parent,command['log'])
                    closure.require(log.is_file() and closure.digest(log)==command['log_sha256'],'Component command log differs')
                result[name].append(record)
            else:
                closure.require(verified.get((record['case_id'],record['variant']))==record,'Evidence class does not name independently checked full evidence: '+name)
                result[name].append(record)
    return result


def pin(base, record):
    closure.require(isinstance(record,dict) and set(record)=={'path','sha256','size'},'Exact artifact content pin required')
    path=closure.path_from(base,record['path'])
    closure.require(path.is_file() and not path.is_symlink(),'Release artifact missing or symbolic')
    closure.require(type(record['size']) is int and record['size']>=0 and path.stat().st_size==record['size'],'Release artifact size differs')
    closure.require(record['sha256']==closure.digest(path),'Release artifact checksum differs')
    return path

def verify_inputs(manifest_path, manifest):
    closure.require(set(manifest)=={'schema_version','release_id','source','source_format_version','protocol_version','closure_packet','artifacts','operator_acceptance','runtime','evidence_classes'},'Release manifest fields differ from version 2')
    closure.require(type(manifest['schema_version']) is int and manifest['schema_version']==2 and all(type(manifest[key]) is int and manifest[key]==1 for key in ['source_format_version','protocol_version']),'Unsupported release source format or protocol')
    closure.require(str(uuid.UUID(manifest['release_id']))==manifest['release_id'],'Canonical release identity required')
    source=closure.source_identity(manifest['source'])
    base=Path(manifest_path).resolve().parent
    artifacts=manifest['artifacts']
    closure.require(isinstance(artifacts,list) and artifacts,'Packaged release artifacts required')
    covered=set(); paths=set()
    for artifact in artifacts:
        closure.require(isinstance(artifact,dict) and set(artifact)=={'roles','path','sha256','size'},'Release artifact roles and pin required')
        roles=artifact['roles']
        closure.require(isinstance(roles,list) and roles and len(set(roles))==len(roles) and set(roles)<=ROLES,'Release artifact roles are invalid')
        path=pin(base,{key:artifact[key] for key in ('path','sha256','size')})
        closure.require(path.resolve() not in paths,'Duplicate release artifact')
        paths.add(path.resolve());covered.update(roles)
    closure.require(covered==ROLES,'Missing packaged roles: '+', '.join(sorted(ROLES-covered)))
    evidence_inventory(manifest)
    closure.require(isinstance(manifest['runtime'],dict) and set(manifest['runtime'])=={'package_manifest','profile','receipt'},'Exact running system pins required')
    for record in manifest['runtime'].values():pin(base,record)
    packet=pin(base,manifest['closure_packet'])
    acceptance_file=pin(base,manifest['operator_acceptance'])
    acceptance=closure.load(acceptance_file)
    closure.require(set(acceptance)=={'schema_version','release_id','accepted','accepted_by','accepted_at','source_revision_id','closure_packet_sha256','runtime_receipt_sha256','runtime_profile_sha256'},'Exact operator acceptance record required')
    closure.require(type(acceptance['schema_version']) is int and acceptance['schema_version']==1 and acceptance['accepted'] is True,'Explicit operator acceptance is required')
    closure.require(acceptance['release_id']==manifest['release_id'] and acceptance['source_revision_id']==source['revision_id'] and acceptance['closure_packet_sha256']==manifest['closure_packet']['sha256'] and acceptance['runtime_receipt_sha256']==manifest['runtime']['receipt']['sha256'] and acceptance['runtime_profile_sha256']==manifest['runtime']['profile']['sha256'],'Operator acceptance does not bind this release')
    closure.require(isinstance(acceptance['accepted_by'],str) and bool(acceptance['accepted_by'].strip()),'Operator acceptance identity required')
    stamp=acceptance['accepted_at']
    closure.require(isinstance(stamp,str) and stamp.endswith('Z'),'Operator acceptance must use UTC time')
    observed=dt.datetime.fromisoformat(stamp.replace('Z','+00:00'))
    closure.require(observed<=dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5),'Operator acceptance cannot be future dated')
    return packet

def verify_runtime_receipt(base,manifest):
    path=pin(base,manifest['runtime']['receipt']);receipt=closure.load(path)
    closure.require(receipt.get('schema_version')==1 and receipt.get('status')=='PASS'
                    and receipt.get('scope')=='released source running system','Running system receipt is required')
    closure.require(receipt.get('release_id')==manifest['release_id'] and receipt.get('source')==manifest['source']
                    and receipt.get('profile_sha256')==manifest['runtime']['profile']['sha256']
                    and receipt.get('package_manifest_sha256')==manifest['runtime']['package_manifest']['sha256']
                    and receipt.get('artifact_sha256') in {a['sha256'] for a in manifest['artifacts']},'Running system receipt is stale')
    checks=receipt.get('checks')
    closure.require(isinstance(checks,list) and len(checks)==len(RUNTIME_CHECKS)
                    and {row['id'] for row in checks}==RUNTIME_CHECKS
                    and all(row.get('status')=='PASS' for row in checks),'Running system checks are incomplete')
    verify_custody(manifest['source'],receipt['custody'])
    closure.require(receipt.get('cleanup_complete') is True,'Running service cleanup is incomplete')
    for record in receipt['evidence'].values():pin(path.parent,record)
    closure.require(set(receipt['evidence'])=={'journey','publication','before','after','dump','restore_log','service_log'},'Running evidence inventory differs')
    before=closure.load(pin(path.parent,receipt['evidence']['before']))
    after=closure.load(pin(path.parent,receipt['evidence']['after']))
    closure.require(before==after and before.get('accepted_roots'),'Restored roots or object metadata differ')
    publication=closure.load(pin(path.parent,receipt['evidence']['publication']))
    closure.require(publication.get('status')=='PASS' and publication.get('dropped_response') is True
                    and publication.get('remote_ref_updates')==1 and publication.get('resume_replayed') is True,'Ambiguous publication was not reconciled once')
    journey=closure.load(pin(path.parent,receipt['evidence']['journey']))
    closure.require(journey.get('source')==manifest['source'] and journey.get('custody')==receipt['custody'],
                    'Running journey source or custody differs')
    profile=private_profile(base,manifest['runtime']['profile'])
    closure.require(profile['source']==manifest['source'],'Runtime profile source is stale')
    closure.require(publication.get('source')==manifest['source'] and publication.get('operation_id')==profile['publication']['operation_id'],
                    'Publication probe does not bind this running system')
    # Custody must still be current at closure, rather than merely in a saved receipt.
    with tempfile.TemporaryDirectory(prefix='hf-release-custody-') as temporary:
        directory=Path(temporary);runtime,_=extract_runtime(base,manifest,directory)
        config=directory/'config.json'
        config.write_bytes(closure.canonical({'runtime':str(runtime),'profile':profile,'directory':str(directory)}));config.chmod(0o600)
        env={'PATH':str(runtime/'bin')+':/usr/bin:/bin','LANG':'C.UTF-8',**profile['environment'],
             'LD_LIBRARY_PATH':str(runtime/'lib/hyperfide')}
        current=subprocess.run([str(runtime/'runtime/node'),str(ROOT/'tests/hyperfide/support/native_source_full_journey.mjs'),
                                '--release','current',str(config)],env=env,capture_output=True,text=True,timeout=60)
        closure.require(current.returncode==0,'Stale custody or unavailable current deployment at release closure')
        verify_custody(manifest['source'],closure.load(directory/'current.json'))
    return receipt


def case_outcomes(checked):
    claims=closure.load(ROOT/'tests/hyperfide/source-control/claims.json')['cases']
    passed={(row['case_id'],row['variant']) for row in checked}
    return [{'case_id':case_id,'variant':variant,'status':'PASS' if (case_id,variant) in passed else 'UNRUN'}
            for case_id,claim in sorted(claims.items()) for variant in claim['required_variants']]


def write_report(report,name='closure-report.json'):
    OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
    target=OUT/name
    target.write_text(json.dumps(report,indent=2)+'\n');target.chmod(0o600)
    return target


def verify_release(manifest_path):
    manifest=closure.load(manifest_path)
    packet=verify_inputs(manifest_path,manifest)
    report=closure.verify_packet(packet)
    closure.require(report['release_id']==manifest['release_id'] and report['source']==manifest['source'],'Qualified packet does not bind this release')
    base=Path(manifest_path).resolve().parent
    classes=verify_evidence_classes(base,manifest,report['checked_evidence'])
    runtime=verify_runtime_receipt(base,manifest)
    return {'schema_version':2,'status':'PASS','scope':'release closure','release_id':report['release_id'],
            'source':report['source'],'manifest_sha256':closure.digest(manifest_path),
            'closure_packet_sha256':report['packet_sha256'],'evidence_classes':classes,
            'verified_case_variants':len(report['checked_evidence']),'cases':case_outcomes(report['checked_evidence']),
            'running_system':manifest['runtime']['receipt'],'running_checks':runtime['checks'],
            'operator_acceptance':manifest['operator_acceptance']['sha256']}


def private_profile(base,record):
    path=pin(base,record)
    closure.require(path.stat().st_uid==os.getuid() and path.stat().st_mode&0o077==0,'Runtime profile must be owner-only')
    profile=closure.load(path)
    closure.require(set(profile)=={'schema_version','disposable_restore_drill','database_name','system_identifier',
                    'environment','source','journey','recovery_profile','publication','inputs'},'Runtime profile fields differ')
    closure.require(type(profile['schema_version']) is int and profile['schema_version']==1
                    and profile['disposable_restore_drill'] is True,'Restore requires an explicitly disposable drill database')
    closure.source_identity(profile['source'])
    env=profile['environment']
    closure.require(isinstance(env,dict) and env and all(isinstance(k,str) and isinstance(v,str) for k,v in env.items()),'Exact service environment required')
    closure.require({'DATABASE_URL','HYPERFIDE_DEPLOYMENT_ID','HYPERFIDE_AUTHORITY_JOURNAL_DIR','HF_SOURCE_CONTROL_CONFIG'}<=set(env),'Qualified service environment is incomplete')
    closure.require(not ({'NODE_OPTIONS','NODE_PATH','LD_PRELOAD','PATH','HF_SOURCE_PACKAGE_ROOT'}&set(env)),'Runtime environment may not override package execution')
    closure.require(Path(env['HYPERFIDE_AUTHORITY_JOURNAL_DIR']).is_absolute(),'External authority journal must remain outside database restoration')
    closure.require(profile['source']['scope']==profile['journey']['scope'],'Journey scope differs')
    closure.require(set(profile['inputs'])=={'HF_SOURCE_CONTROL_CONFIG','HF_SOURCE_PUBLICATION_CONFIG'},'Pinned listener and publication inputs required')
    for record in [*profile['inputs'].values(),profile['recovery_profile']]:
        closure.require(Path(record['path']).is_absolute(),'Qualified deployment inputs require absolute paths')
    for name,record in profile['inputs'].items():
        closure.require(str(pin(path.parent,record))==env[name],'Qualified runtime input path differs: '+name)
    listener=closure.load(env['HF_SOURCE_CONTROL_CONFIG'])
    closure.require(listener.get('host') in ['127.0.0.1','::1'] and listener.get('port')==0,'Restore drill listener requires a private ephemeral loopback port')
    pin(path.parent,profile['recovery_profile'])
    return profile


def run_logged(argv,env,log,timeout=300):
    with Path(log).open('ab') as stream:
        result=subprocess.run(argv,cwd=ROOT,env=env,stdout=stream,stderr=stream,timeout=timeout)
    closure.require(result.returncode==0,'Running system command failed: '+Path(argv[0]).name+'; private log '+str(log))


def extract_runtime(base,manifest,directory):
    package_path=pin(base,manifest['runtime']['package_manifest']);package=closure.load(package_path)
    archive=pin(package_path.parent,package['artifact'])
    runtime=directory/'runtime';runtime.mkdir()
    with tarfile.open(archive) as bundle:
        closure.require(all(not Path(m.name).is_absolute() and '..' not in Path(m.name).parts for m in bundle.getmembers()),'Unsafe release archive member')
        bundle.extractall(runtime,filter='data')
    loader=importlib.util.spec_from_file_location('source_package_verifier',Path(__file__).with_name('7_1.py'))
    packaging=importlib.util.module_from_spec(loader);loader.loader.exec_module(packaging)
    inventory=packaging.verify(runtime)
    closure.require(closure.digest(runtime/'runtime-manifest.json')==package['runtime_manifest_sha256'],'Runtime manifest is stale')
    contract=packaging.release_manifest(runtime,inventory,package)
    closure.require(contract['source_format_version']==manifest['source_format_version'] and contract['protocol_version']==manifest['protocol_version'],'Release package compatibility differs')
    return runtime,package


def running_system_phase(manifest_path):
    """Execute only against an explicitly disposable, qualified deployment copy.

    Operator acceptance is recorded AFTER this phase and pins its immutable receipt.
    The bounded self-test never enters this deployment/campaign path.
    """
    manifest=closure.load(manifest_path);base=Path(manifest_path).resolve().parent
    profile=private_profile(base,manifest['runtime']['profile'])
    closure.require(profile['source']==manifest['source'],'Runtime profile source is stale')
    package_path=pin(base,manifest['runtime']['package_manifest']);package=closure.load(package_path)
    pin(package_path.parent,package['artifact'])
    closure.require(any(a['sha256']==package['artifact']['sha256'] and set(a['roles'])==ROLES for a in manifest['artifacts']),'The 7.1 package must cover every runtime role')
    OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
    directory=OUT/('running-'+str(uuid.uuid4()));directory.mkdir(mode=0o700)
    runtime,package=extract_runtime(base,manifest,directory)
    env={'PATH':str(runtime/'bin')+':/usr/bin:/bin','LANG':'C.UTF-8',**profile['environment'],
         'LD_LIBRARY_PATH':str(runtime/'lib/hyperfide')}
    node=str(runtime/'runtime/node');helper=str(ROOT/'tests/hyperfide/support/native_source_full_journey.mjs')
    config=directory/'journey-config.json'
    config.write_bytes(closure.canonical({'runtime':str(runtime),'profile':profile,'directory':str(directory)}));config.chmod(0o600)
    def drive(mode):
        run_logged([node,helper,'--release',mode,str(config)],env,directory/(mode+'.log'))
    # Check the independently pinned PostgreSQL identity before any mutating drill.
    drive('preflight')
    server=None;service_log=directory/'service.log'
    def stop():
        nonlocal server
        if server is None:return
        child=server;server=None
        child.terminate()
        try:code=child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill();child.wait();raise closure.ClosureError('Packaged source service failed to stop cleanly')
        if child.stdout:child.stdout.close()
        closure.require(code==0,'Packaged source service did not stop cleanly')
    def start():
        nonlocal server
        log=service_log.open('ab')
        server=subprocess.Popen([str(runtime/'bin/source-control')],cwd=runtime,env=env,stdout=subprocess.PIPE,stderr=log)
        log.close()
        selector=selectors.DefaultSelector();selector.register(server.stdout,selectors.EVENT_READ)
        deadline=time.monotonic()+30
        try:
            while time.monotonic()<deadline:
                if not selector.select(max(0,deadline-time.monotonic())):break
                line=server.stdout.readline()
                with service_log.open('ab') as stream:stream.write(line)
                if not line:break
                event=json.loads(line)
                if event.get('event')=='source-control.ready':
                    value=closure.load(config);value['endpoint']=event['address']+'/api/v1/source-control'
                    config.write_bytes(closure.canonical(value));return
            raise closure.ClosureError('Packaged source service readiness failed; private log '+str(service_log))
        finally:selector.close()
    try:
        start();drive('journey');drive('publication');drive('before')
        stop();drive('preflight')
        dump=directory/'metadata.dump'
        run_logged(['pg_dump','--format=custom','--no-owner','--no-acl','--file',str(dump)],
                   {**env,'PGDATABASE':env['DATABASE_URL']},directory/'dump.log')
        drive('preflight')
        # Includes source_native_objects, placements, routing, pins and accepted roots.
        # The independent authority journal is deliberately never copied or restored.
        run_logged(['pg_restore','--clean','--if-exists','--exit-on-error','--single-transaction','--no-owner','--no-acl',
                    '--dbname',env['DATABASE_URL'],str(dump)],env,directory/'restore.log')
        start();drive('after');stop()
        before=closure.load(directory/'before.json');after=closure.load(directory/'after.json')
        closure.require(before==after and before['accepted_roots'],'Restored source roots or object metadata differ')
        journey=closure.load(directory/'journey.json');verify_custody(manifest['source'],journey['custody'])
        def content(path):return {'path':str(path),'sha256':closure.digest(path),'size':path.stat().st_size}
        report={'schema_version':1,'status':'PASS','scope':'released source running system',
                'release_id':manifest['release_id'],'source':manifest['source'],
                'profile_sha256':manifest['runtime']['profile']['sha256'],
                'package_manifest_sha256':manifest['runtime']['package_manifest']['sha256'],
                'artifact_sha256':package['artifact']['sha256'],'custody':journey['custody'],
                'checks':[{'id':name,'status':'PASS'} for name in sorted(RUNTIME_CHECKS)],'cleanup_complete':True,
                'evidence':{name:content(directory/filename) for name,filename in {
                    'journey':'journey.json','publication':'publication.json','before':'before.json','after':'after.json',
                    'dump':'metadata.dump','restore_log':'restore.log','service_log':'service.log'}.items()}}
        target=directory/'receipt.json';target.write_bytes(closure.canonical(report));target.chmod(0o600)
        return {**report,'receipt':content(target)}
    finally:
        stop()


def self_test():
    checks=[]
    with tempfile.TemporaryDirectory(prefix='hf-source-release-') as temporary:
        root=Path(temporary);artifact=root/'runtime.tar';artifact.write_bytes(b'owned release artifact')
        packet=root/'packet.json';packet.write_bytes(b'{}')
        source={'scope':{key:str(uuid.uuid4()) for key in ['organisation_id','repository_id','security_domain_id']},'revision_id':'sha256:'+'a'*64,'root_tree_id':'sha256:'+'b'*64,'authority_epoch':'1','policy_version':'release-check'}
        def content(path):return {'path':path.name,'sha256':closure.digest(path),'size':path.stat().st_size}
        release_id=str(uuid.uuid4());acceptance=root/'acceptance.json'
        acceptance_value={'schema_version':1,'release_id':release_id,'accepted':True,'accepted_by':'declared-test-operator','accepted_at':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z'),'source_revision_id':source['revision_id'],'closure_packet_sha256':closure.digest(packet),'runtime_receipt_sha256':closure.digest(packet),'runtime_profile_sha256':closure.digest(packet)}
        acceptance.write_bytes(closure.canonical(acceptance_value))
        manifest={'schema_version':2,'release_id':release_id,'source':source,'source_format_version':1,'protocol_version':1,'closure_packet':content(packet),'artifacts':[dict(content(artifact),roles=sorted(ROLES))],'operator_acceptance':content(acceptance),'runtime':{key:content(packet) for key in ['package_manifest','profile','receipt']},'evidence_classes':{'component':[content(artifact)],**{name:[{'case_id':case,'variant':variant,'receipt_id':str(uuid.uuid4()),'receipt_sha256':'a'*64} for case,variant in sorted(variants)] for name,variants in CLASS_VARIANTS.items()}}}
        target=root/'release.json';target.write_bytes(closure.canonical(manifest))
        if verify_inputs(target,manifest)!=packet:raise AssertionError('Artifact validation did not preserve packet')
        checks.append('artifact-pins-and-acceptance-binding')
        helper=ROOT/'tests/hyperfide/support/native_source_full_journey.mjs'
        loaded=subprocess.run(['node','--input-type=module','-e','await import(process.argv[1])',helper.as_uri()],capture_output=True,text=True,timeout=30)
        if loaded.returncode:raise AssertionError('Release journey module failed to load: '+loaded.stderr)
        checks.append('release-journey-module-loads')
        template=closure.load(ROOT/'tests/hyperfide/source-control/manifests/release.json')
        evidence_inventory(template)
        if set(template)!=set(manifest) or template['schema_version']!=2:raise AssertionError('Release manifest template schema differs')
        checks.append('release-manifest-template')
        def refused(name, value, expected):
            try:verify_inputs(target,value)
            except closure.ClosureError as error:
                if expected not in str(error):raise AssertionError((name,str(error)))
                checks.append(name)
            else:raise AssertionError(name+' passed unexpectedly')
        bad=copy.deepcopy(manifest);bad['artifacts'][0]['sha256']='0'*64;refused('artifact-tamper',bad,'checksum')
        bad=copy.deepcopy(manifest);bad['artifacts'][0]['roles']=['native'];refused('missing-runtime-roles',bad,'Missing packaged')
        bad=copy.deepcopy(manifest);bad['source_format_version']=2;refused('unsupported-source-format',bad,'Unsupported')
        bad=copy.deepcopy(manifest);bad['source']['revision_id']='sha256:'+'c'*64;refused('acceptance-other-source',bad,'does not bind')
        for name in ['component',*CLASS_VARIANTS]:
            bad=copy.deepcopy(manifest);del bad['evidence_classes'][name]
            refused('missing-evidence-class-'+name,bad,'Missing required evidence class')
            bad=copy.deepcopy(manifest);bad['evidence_classes'][name]=[]
            refused('empty-evidence-class-'+name,bad,'Missing required evidence class')
        custody={**source,'custody_id':str(uuid.uuid4()),'custody_generation':'1','qualified_custody_generation':'1',
                 'authority':'ACTIVE','revoked_at':None,'qualification_outcome':'PASS',
                 'qualification_id':'sha256:'+'d'*64,'current_qualification_id':'sha256:'+'d'*64}
        custody['current_custody_id']=custody['custody_id'];verify_custody(source,custody)
        checks.append('current-custody-binding')
        for field,value in [('scope',{**source['scope'],'repository_id':str(uuid.uuid4())}),('current_custody_id',str(uuid.uuid4())),('qualified_custody_generation','2'),
                            ('authority','SUPERSEDED'),('revoked_at','revoked'),('qualification_outcome','PENDING'),
                            ('current_qualification_id','sha256:'+'e'*64),('authority_epoch','2'),
                            ('revision_id','sha256:'+'f'*64),('root_tree_id','sha256:'+'f'*64),('policy_version','old')]:
            bad={**custody,field:value}
            try:verify_custody(source,bad)
            except closure.ClosureError as error:
                if 'Stale custody' not in str(error):raise
                checks.append('stale-custody-'+field)
            else:raise AssertionError('Stale custody accepted: '+field)
        for name in ['custody_id','revoked_at','current_qualification_id']:
            bad=copy.deepcopy(custody);del bad[name]
            try:verify_custody(source,bad)
            except closure.ClosureError:checks.append('missing-custody-'+name)
            else:raise AssertionError('Missing custody binding accepted: '+name)
        bad=copy.deepcopy(manifest);bad['evidence_classes']['github'][0]['variant']='gitlab'
        refused('wrong-evidence-class-variant',bad,'Evidence class variant inventory')
        acceptance_value['runtime_receipt_sha256']='0'*64;acceptance.write_bytes(closure.canonical(acceptance_value))
        bad=copy.deepcopy(manifest);bad['operator_acceptance']=content(acceptance);refused('acceptance-other-running-system',bad,'does not bind')
        acceptance_value['runtime_receipt_sha256']=closure.digest(packet)
        acceptance_value['accepted']=False;acceptance.write_bytes(closure.canonical(acceptance_value));bad=copy.deepcopy(manifest);bad['operator_acceptance']=content(acceptance);refused('operator-refusal',bad,'Explicit operator')
    return {'schema_version':1,'status':'PASS','scope':'release input validation; running system and complete canonical evidence required separately','checks':checks,'cases':case_outcomes([]),'evidence_classes':{name:[] for name in ['component',*CLASS_VARIANTS]}}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',default=os.environ.get('HF_SOURCE_RELEASE_MANIFEST'))
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--run-system',action='store_true',help='Run the qualified disposable restore drill before recording operator acceptance')
    args=parser.parse_args()
    os.umask(0o077)
    try:
        closure.require(not (args.self_test and args.run_system),'Select either bounded self-test or running system phase')
        if args.self_test:
            report=self_test()
            for name in report['checks']:
                print(json.dumps({'type':'assertion','id':'source-release.'+name,'expected':True,'actual':True}))
            print(json.dumps({'type':'cleanup','complete':True,'resources':[]}))
        else:
            if not args.manifest:raise closure.ClosureError('HF_SOURCE_RELEASE_MANIFEST or --manifest must identify the qualified release and operator acceptance')
            report=running_system_phase(args.manifest) if args.run_system else verify_release(args.manifest)
        write_report(report)
        if args.self_test:write_report(report,'receipt.json')
        print(json.dumps(report,sort_keys=True));return 0
    except (closure.ClosureError,AssertionError,OSError,ValueError,TypeError,KeyError,subprocess.SubprocessError,tarfile.TarError) as error:
        report={'schema_version':2,'status':'BLOCKED','diagnostics':[str(error)],'cases':case_outcomes([])}
        write_report(report);print(json.dumps(report));return 2

if __name__=='__main__':raise SystemExit(main())
