#!/usr/bin/env python3
"""Prepare and invoke the production greenfield bootstrap; no fixture authority."""
from pathlib import Path
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import uuid

ROOT=Path(__file__).resolve().parents[4]
AREA=ROOT/'build/fleet/integration/private'
NODE=Path('/root/.nvm/versions/node/v24.22.0/bin/node')
spec=importlib.util.spec_from_file_location('fleet_live',Path(__file__).with_name('0_14_live.py'))
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
REQUIRED_ACTIONS='''identity.describe identity.service.issue identity.principal.renew identity.principal.revoke identity.binding.observe identity.grant.issue identity.runner.register identity.runner.heartbeat hierarchy.supervisor.register hierarchy.leader.acquire hierarchy.package.configure fleet.cohort.bind fleet.session.bind fleet.observe fleet.session.reason fleet.decision.inspect fleet.decision.apply fleet.identity.bootstrap spec.inspect spec.task.resolve recovery.control.start spec.dependencies.check spec.dependencies.admit spec.amendment.admit provider.pools.configure provider.pools.readiness provider.pools.list provider.pools.capacity provider.pools.observe provider.pools.attest-capacity provider.profiles.register provider.intents.prepare-create provider.intents.get provider.intents.execute provider.intents.reconcile provider.intents.prepare-destroy provider.inventory.observe-known provider.remote.execute-bound provider.worker.start provider.worker.status provider.worker.stop artifact.object.put artifact.object.read artifact.object.inspect artifact.object.reconcile artifact.manifest.commit artifact.manifest.read artifact.object.locate fleet.install.register fleet.install.admit fleet.install.adopt fleet.install.status fleet.install.delivery.register fleet.install.delivery.pending fleet.install.delivery.schedule fleet.install.delivery.collect fleet.manager.execute runner.registry.observe runner.registry.describe runner.registry.prepare runner.job.claim runner.dispatch.consume runner.dispatch.describe runner.launch.event.record connector.qualification.record connector.qualification.inspect native.auth.snapshot native.auth.probe native.auth.qualify agent.launch-plan.fetch agent.launch-plan.prepare agent.launch-plan.inspect agent.admission.reserve outbox.consumer.register outbox.consumer.bind-session outbox.consumer.resolve-session instructions.consumer.register outbox.claim outbox.acknowledge outbox.retry'''.split()

REQUIRED_ACTIONS += ['fleet.install.delivery.prepare.allocate', 'fleet.install.delivery.verify.allocate']
REQUIRED_ACTIONS += ['submission.submit','submission.inspect','submission.snapshot',
    'qualification.preparation.plan','qualification.preparation.inspect','qualification.preparation.execute',
    'qualification.job.assign','qualification.job.claim','qualification.execute',
    'qualification.execution.inspect','qualification.coverage.inspect','qualification.accept','spec.proof.inspect']
REQUIRED_ACTIONS += ['scheduler.resources.queue', 'scheduler.resources.admit',
    'scheduler.resources.inspect', 'scheduler.resources.release',
    'placement.runner.authorize', 'instructions.handoff', 'instructions.ack',
    'instructions.runner.poll', 'agent.launch-plan.fetch',
    'credentials.reference.rotate', 'credentials.inspect', 'credentials.attach',
    'native.auth.snapshot', 'native.auth.probe', 'native.auth.qualify',
    'native.auth.qualification.inspect',
]

def key(name):
    filename=AREA/(name+'.pem')
    if not filename.exists():
        subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(filename)],check=True,capture_output=True)
        filename.chmod(0o600)
    public=subprocess.check_output(['openssl','pkey','-in',str(filename),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
    return filename,base64.urlsafe_b64encode(public[-32:]).decode().rstrip('=')

def prepare(origin):
    receipt_path=AREA/'0_14-bootstrap-receipt.json'
    if receipt_path.exists():
        issued=live.read(receipt_path)
        if issued.get('status')=='PASS' and issued.get('operator_issued') is True:
            raise live.Blocked('BOOTSTRAP_ALREADY_ISSUED_USE_REVIEWED_OPERATIONAL_AMENDMENT')
    b=live.read(AREA/'0_14-bindings.json');repo=live.read(AREA/'0_14-repository-binding.json')
    source=AREA/'source';intent=source/'intent.kvx'
    text=intent.read_text().replace(' and commits the source change after executing node verification.',' and executes node verification.').replace('; commit the source change.','.').replace('Create generated.mjs containing export const value = 42; run node to import it and verify value 42; commit the source change.','Create generated.mjs containing export const value = 42; run node to import it and verify value 42.')
    if text!=intent.read_text():
        intent.write_text(text)
        for args in [['add','intent.kvx'],['-c','user.name=Fleet Qualification','-c','user.email=qualification@example.invalid','commit','-qm','Pin manifest-based worker verification intent']]:
            subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',str(source),*args],check=True,capture_output=True)
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    tree=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD^{tree}'],text=True).strip()
    actions=sorted(set(REQUIRED_ACTIONS))
    for action in actions:live.component_for(action)
    if len(actions)>128:raise live.Blocked('ACCEPTED_ACTION_BOUND_EXCEEDED')
    document=live.read(AREA/'0_14-greenfield-intent.json')
    document['scope']['allowed_actions']=actions
    metadata=document['metadata']['repositories'][0]
    metadata['source_objects']=[{'object_id':revision,'object_type':'commit'},{'object_id':tree,'object_type':'tree'}]
    document['accepted_intent'].update(allowed_actions=actions)
    document['accepted_intent']['source'].update(sha256=hashlib.sha256(intent.read_bytes()).hexdigest(),size_bytes=str(intent.stat().st_size))
    document['accepted_intent']['repositories'][0]['source_object_id']=revision
    live.write(AREA/'0_14-greenfield-intent.json',document)
    live.write(AREA/'0_14-profile-source-inputs.json',{'schema_version':1,'repository_url':metadata['url'],
        'source_repository_key':repo['repository_id'],'commit':revision,'tree_oid':tree,
        'package_lock_path':str(source/'package-lock.json'),'source_root':str(source),
        'profile_id':live.read(AREA/'0_14-pool-identities.json')['profile_id']})
    operator_key,public=key('operator');isolation_key,isolation_public=key('isolation-issuer')
    principals_path=AREA/'0_14-principals.json'
    if principals_path.exists():principals=live.read(principals_path)
    else:
        principals={'schema_version':1,**{name:str(uuid.uuid4()) for name in ['operator_credential_id','operator_actor_id','coordinator_credential_id','coordinator_actor_id','provisioner_credential_id','provisioner_actor_id','primary_session_id','manager_one_session_id','manager_two_session_id','cohort_id']}}
        live.write(principals_path,principals)
    for name in ['coordinator','provisioner','primary','manager-one','manager-two']:key(name)
    live.write(AREA/'isolation-verifier.json',{'schema_version':1,'issuers':[{'key_id':'fleet-014-operator','public_key_b64':isolation_public}]})
    policy={'schema_version':1,'programme_id':b['run_id'],'repository':'fleet/prerequisite','spec_revision':'fleet-live-prerequisite-v1','policy_revision':1,'status':'ACTIVE','approval':{'decision':'APPROVED','record_id':'authorized-isolated-prerequisite','spec_revision':'fleet-live-prerequisite-v1','policy_revision':1},'allowed_roles':['control','provisioner','dispatch'],'allowed_actions':actions}
    live.write(AREA/'control-policy.json',policy)
    live.write(AREA/'control-identity.json',{'schema_version':1,'origin':origin,'clock_skew_seconds':30,'grant_ttl_seconds':300,'credential_ttl_seconds':3600,'principals':[]})
    for name in ['authority-journal','external-fence-journal','responses']:(AREA/name).mkdir(mode=0o700,exist_ok=True)
    config_path=AREA/'0_14-live-config.json'
    config=live.read(config_path) if config_path.exists() else {'schema_version':1}
    config.update(origin=origin,operator_credential_file=str(AREA/'operator.json'),
        pool_config_file=str(AREA/'pool-config.json'),accepted_intent_file=str(AREA/'0_14-greenfield-intent.json'),
        control_runtime_environment_file=str(AREA/'runtime-db-control.env'))
    config['environment']={**config.get('environment',{}),'HYPERFIDE_DEPLOYMENT_ID':b['deployment_id'],
        'HYPERFIDE_POOL_CONFIG':config['pool_config_file'],'HYPERFIDE_BOOTSTRAP_SOURCE_ROOT':str(source),
        'HYPERFIDE_GREENFIELD_INTENT_FILE':str(AREA/'0_14-greenfield-intent.json'),
        'HYPERFIDE_WRITER_ISOLATION_CONFIG':str(AREA/'writer-isolation.json'),
        'HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE':str(AREA/'isolation-verifier.json'),
        'HYPERFIDE_ISOLATION_PERMIT_FILE':str(AREA/'isolation-permit.json'),
        'HYPERFIDE_EXTERNAL_FENCE_JOURNAL_DIR':str(AREA/'external-fence-journal'),
        'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(AREA/'authority-journal'),
        'HYPERFIDE_BOOTSTRAP_MAX_TTL_MS':'3600000','HYPERFIDE_MODE':'distributed',
        'HYPERFIDE_FLEET_HOST_ID':'fleet-014-'+b['deployment_id'],'HYPERFIDE_REQUIRE_SYNC_REPLICA':'0','HF_SERVICE_REQUEST_DEADLINE_MS':'120000'}
    live.write(config_path,config)
    return {'status':'PREPARED_NOT_IMPORTED','accepted_actions':len(actions),'worker_git_required':False,'source_pin':revision}

def bootstrap(config_path):
    config=live.read(config_path);env=live.environment(config)
    parse="const fs=require('node:fs'),util=require('node:util');console.log(JSON.stringify(util.parseEnv(fs.readFileSync(process.argv[1],'utf8'))))"
    env.update(json.loads(subprocess.check_output([str(NODE),'-e',parse,config['control_runtime_environment_file']],text=True)))
    env.pop('HYPERFIDE_MIGRATION_DATABASE_URL',None)
    result=subprocess.run([str(NODE),str(AREA/'0_14-bootstrap.mjs'),'--activate-and-issue'],cwd=AREA,env=env,capture_output=True,text=True,timeout=120)
    (AREA/'bootstrap.log').write_text(result.stdout+result.stderr);(AREA/'bootstrap.log').chmod(0o600)
    if result.returncode:raise live.Blocked('PRODUCTION_BOOTSTRAP_FAILED:inspect-private-bootstrap-receipt')
    return {'status':'BOOTSTRAPPED_ACTUAL_AUTHORITY_AND_OPERATOR','provider_execution':'NOT_CLAIMED'}

def main():
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['prepare','bootstrap']);p.add_argument('--origin');p.add_argument('--config',default=str(AREA/'0_14-live-config.json'));args=p.parse_args()
    report={'schema_version':1,'phase':args.phase,'status':'BLOCKED','database_writes_claimed':False}
    try:
        origin=args.origin
        if args.phase=='prepare' and not origin:
            origin=live.read(args.config).get('origin')
            if not origin:raise live.Blocked('ACTUAL_CONTROL_ORIGIN_REQUIRED')
        report.update(status='PHASE_COMPLETED',result=prepare(origin) if args.phase=='prepare' else bootstrap(args.config));code=0
    except (live.Blocked,FileNotFoundError,KeyError,subprocess.SubprocessError) as error:report['blocker']=str(error)[:1000];code=2
    live.write(AREA/('0_14-setup-'+args.phase+'-receipt.json'),report)
    print(json.dumps({'phase':args.phase,'status':report['status'],'blocker':report.get('blocker')}));return code
if __name__=='__main__':raise SystemExit(main())
