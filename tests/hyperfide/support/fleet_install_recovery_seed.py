"""Explicit accepted inputs for the isolated installation recovery engine case.

This helper never creates a runner job, execution result, quiescence observation,
READY publication or resumed filesystem result. Authored decision envelopes are
fixture INPUTS, not model inference evidence. Recovery is applied by the normal
signed production action against genuinely captured failed execution evidence.
"""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import socket
import uuid


def uid():return str(uuid.uuid4())
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(value):return 'sha256:'+hashlib.sha256(value if isinstance(value,bytes) else canonical(value)).hexdigest()
def one(f,sql,args=()):
 rows=f.sql(sql,list(args))
 if len(rows)!=1:raise ValueError('Exactly one accepted fixture input required: '+sql[:90])
 return rows[0]
def insert(f,table,value,json_columns=()):
 columns=list(value);params=[json.dumps(value[k],ensure_ascii=False) if k in json_columns else value[k] for k in columns]
 positions=[f'${n}'+('::jsonb' if k in json_columns else '') for n,k in enumerate(columns,1)]
 f.sql('INSERT INTO hyperfide.'+table+'('+','.join(columns)+') VALUES('+','.join(positions)+')',params)


def seed_manager_inputs(f,stack,claimed):
 """Bind actual claimed package/manager and running fixture process; no effects."""
 if not str(f.database).startswith('hf_') or not f.child or f.child.poll() is not None:raise ValueError('Owned running isolated fixture required')
 i=f.ids;scope=[i['organisation'],i['run']];token=claimed['token']
 package=one(f,'SELECT p.id,p.manager_session_id,h.owner_generation::text,h.state FROM hyperfide.tasks t JOIN hyperfide.feature_packages p ON p.organisation_id=t.organisation_id AND p.run_id=t.run_id AND p.id=t.feature_package_id JOIN hyperfide.hierarchy_packages h ON h.organisation_id=p.organisation_id AND h.run_id=p.run_id AND h.package_id=p.id WHERE t.organisation_id=$1 AND t.run_id=$2 AND t.id=$3',scope+[token['task_id']])
 if package['manager_session_id']!=i['manager'] or package['state'] not in ['ASSIGNED','ACTIVE','BLOCKED','CLOSING']:raise ValueError('Actual claimed package must retain its accepted manager')
 leader=one(f,'SELECT * FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2',scope)
 actual=Path('/proc/'+str(f.child.pid)+'/stat').read_text().rsplit(')',1)[1].split()
 identity={'pid':f.child.pid,'start_time':actual[19],'kernel_boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
 cohorts=f.sql('SELECT * FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',scope)
 if cohorts:
  cohort=cohorts[0]
  if cohort['controller_identity']!=identity:raise ValueError('Existing cohort is not owned by this actual fixture process')
 else:
  cohort={'id':uid(),'cohort_generation':1}
  insert(f,'fleet_cohorts',dict(organisation_id=i['organisation'],run_id=i['run'],id=cohort['id'],host_id=socket.gethostname(),authority_epoch=i['epoch'],leader_session_id=leader['leader_session_id'],leader_generation=leader['generation'],cohort_generation=1,controller_identity=identity),('controller_identity',))
 pool=one(f,'SELECT p.id AS pool_id,p.provider,p.profile_id FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id WHERE s.organisation_id=$1 AND s.id=$2',[i['organisation'],token['sandbox_id']])
 if not f.sql('SELECT session_id FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',scope+[i['manager']]):
  insert(f,'fleet_actor_sessions',dict(organisation_id=i['organisation'],run_id=i['run'],session_id=i['manager'],cohort_id=cohort['id'],cohort_generation=cohort['cohort_generation'],actor_role='WAVE_MANAGER',delegation_id=package['id'],manager_generation=package['owner_generation'],state='REGISTERED'))
 if not f.sql('SELECT package_id FROM hyperfide.fleet_delegations WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3',scope+[package['id']]):
  budget={'allowed_actions':['fleet.install.admit'],'provider_ids':[pool['provider']],'profile_ids':[pool['profile_id']],'max_sandboxes':1,'max_concurrent_workers':1,'task_ids':[token['task_id']]}
  insert(f,'fleet_delegations',dict(organisation_id=i['organisation'],run_id=i['run'],package_id=package['id'],manager_session_id=i['manager'],manager_generation=package['owner_generation'],leader_generation=leader['generation'],budget=budget,decision_id=uid()),('budget',))
 return {'package_id':package['id'],'manager_id':i['manager'],'manager_generation':str(package['owner_generation']),'leader_generation':str(leader['generation']),'cohort_id':cohort['id'],'cohort_generation':str(cohort['cohort_generation']),'sandbox_id':token['sandbox_id'],'boot_generation':str(token['sandbox_boot_generation']),'pool_id':pool['pool_id'],'provider_id':pool['provider'],'profile_id':pool['profile_id'],'scope':'EXPLICIT_ISOLATED_AUTHORITY_INPUT_NOT_MODEL_PROOF'}


def seed_initial_admission(f,context,admission):
 """Insert an authored preexisting ADMITTED input; never mark it prepared/ready."""
 a=copy.deepcopy(admission);i=f.ids;scope=[i['organisation'],i['run']]
 if a.get('recovery_of') is not None or a.get('logical_operation_id')!=a.get('operation_id'):raise ValueError('Only an initial logical-root admission may be an accepted fixture input')
 if a.get('organisation_id')!=i['organisation'] or a.get('run_id')!=i['run'] or a.get('authority_epoch')!=i['epoch']:raise ValueError('Admission differs from the owned fixture scope')
 supplied=a.pop('admission_digest',None)
 if supplied!=digest(a):raise ValueError('Canonical initial admission digest differs')
 a['admission_digest']=supplied
 spec=one(f,'SELECT * FROM hyperfide.fleet_environment_specs WHERE organisation_id=$1 AND run_id=$2 AND input_digest=$3',scope+[a['input_digest']])
 for key in ['package_digest','source_config_digest','source_manifest_digest','plan_digest']:
  if a[key]!=spec[key]:raise ValueError('Admission differs from actually registered environment spec: '+key)
 if a['environment_id']!=spec['package_spec']['environment']['environment_id'] or a['environment_generation']!=spec['package_spec']['environment']['environment_generation']:raise ValueError('Initial environment identity differs from registered package')
 # No provisioning result is fabricated here. The accepted sandbox ownership
 # receipt must already exist, or a production provisioning/reuse path must run.
 effects=f.sql("SELECT operation_id FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND result->>'delegation_id'=$3 AND result->>'sandbox_id'=$4 AND result->>'kind' IN('PROVISION_SANDBOX','REUSE_SANDBOX')",scope+[context['package_id'],a['sandbox_id']])
 if not effects:raise ValueError('Accepted prior sandbox ownership effect required; this helper does not fabricate provisioning outcomes')
 insert(f,'fleet_environment_installs',dict(organisation_id=i['organisation'],run_id=i['run'],operation_id=a['operation_id'],input_digest=a['input_digest'],environment_id=a['environment_id'],environment_generation=a['environment_generation'],sandbox_id=a['sandbox_id'],boot_id=a['boot_id'],boot_generation=a['boot_generation'],authority_epoch=a['authority_epoch'],package_id=context['package_id'],manager_session_id=context['manager_id'],manager_generation=context['manager_generation'],leader_generation=context['leader_generation'],cohort_id=context['cohort_id'],cohort_generation=context['cohort_generation'],admission=a,admission_digest=a['admission_digest'],expires_at=a['expires_at']),('admission',))
 insert(f,'fleet_install_heads',dict(organisation_id=i['organisation'],run_id=i['run'],environment_id=a['environment_id'],environment_generation=a['environment_generation'],sandbox_id=a['sandbox_id'],boot_id=a['boot_id'],boot_generation=a['boot_generation'],logical_operation_id=a['operation_id'],current_operation_id=a['operation_id']))
 return a


def _accepted_decision_input(f,context,action,value):
 """Persist explicitly authored test input, never evidence of model inference."""
 i=f.ids;scope=[i['organisation'],i['run']];actor=context['manager_id'];value=copy.deepcopy(value)
 session=one(f,'SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',scope+[actor])
 run=one(f,'SELECT spec_revision_id::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',scope)
 source=one(f,'SELECT source_object_id FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 ORDER BY repository_id LIMIT 1',scope)
 label={'kind':'EXPLICIT_TEST_DECISION_INPUT','model_inference':False,'nonce':uid(),'action':action,'input':value}
 decision={'schema_version':1,'kind':'hyperfide.fleet-decision','decision_id':uid(),'operation_id':uid(),'run_id':i['run'],'actor_id':actor,'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':context['leader_generation'],'delegation_id':context['package_id'],'manager_generation':context['manager_generation'],'source_revision':'git:'+source['source_object_id'],'spec_revision':run['spec_revision_id'],'context_digest':digest(label),'action':action,'input':value,'input_digest':digest(value),'expected_version':session['plan_generation'],'rationale_summary':'Authored isolated engine test INPUT; no model inference or execution outcome is claimed'}
 observation,reason=uid(),uid()
 insert(f,'fleet_observations',dict(organisation_id=i['organisation'],run_id=i['run'],id=observation,actor_id=actor,cohort_generation=context['cohort_generation'],context_digest=decision['context_digest'],body=label),('body',))
 insert(f,'fleet_reasoning',dict(organisation_id=i['organisation'],run_id=i['run'],id=reason,actor_id=actor,request_digest=digest(label),observation_id=observation,state='COMPLETED',result=label),('result',))
 insert(f,'fleet_decisions',dict(organisation_id=i['organisation'],run_id=i['run'],id=decision['decision_id'],operation_id=decision['operation_id'],actor_id=actor,action=decision['action'],context_digest=decision['context_digest'],payload_digest=digest(decision),reasoning_id=reason,body=decision),('body',))
 return decision


def admitted_recovery_decision_input(f,context,install_input,recovery_of):
 """Author a recovery decision input; normal action verifies real failed proof."""
 required={'install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','quiescence_operation_id','quiescence_receipt_digest'}
 if set(recovery_of)!=required:raise ValueError('Exact recovery proof identities required')
 value=copy.deepcopy(install_input);value['recovery_of']=copy.deepcopy(recovery_of)
 return _accepted_decision_input(f,context,'fleet.install.admit',value)


def seed_historical_sandbox_ownership(f,context,controlled_create):
 """Declare prior ownership linked to actual controlled-SDK CREATE metadata.

 This is an accepted historical engine INPUT, not a new provider action/result
 or live-provider proof. It never creates a native execution or install outcome.
 """
 operation=controlled_create['operation'];native_id=controlled_create['native_sandbox_id'];i=f.ids
 physical=one(f,'SELECT s.native_sandbox_id,s.pool_id,s.preparation_digest,p.profile_id FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id WHERE s.organisation_id=$1 AND s.id=$2',[i['organisation'],context['sandbox_id']])
 if operation['kind']!='create' or operation['scope']['organisation_id']!=i['organisation'] or operation['scope']['pool_id']!=physical['pool_id'] or physical['pool_id']!=context['pool_id'] or physical['native_sandbox_id']!=native_id or operation['preparation_digest']!=physical['preparation_digest'] or controlled_create['profile_id']!=physical['profile_id']:raise ValueError('Historical ownership input must bind actual controlled CREATE and current physical fixture metadata')
 value={key:context[key] for key in ['sandbox_id','boot_generation','pool_id','provider_id','profile_id']}
 decision=_accepted_decision_input(f,context,'REUSE_SANDBOX',value)
 result={'kind':'REUSE_SANDBOX','delegation_id':context['package_id'],'sandbox_id':context['sandbox_id'],'boot_generation':context['boot_generation'],'ready':False,'installation_required':True,'input_scope':'EXPLICIT_HISTORICAL_OWNERSHIP_PRECONDITION','controlled_create_operation_id':operation['identity']['operation_id'],'controlled_native_sandbox_id':native_id}
 insert(f,'fleet_effect_receipts',dict(organisation_id=i['organisation'],run_id=i['run'],operation_id=decision['operation_id'],decision_id=decision['decision_id'],payload_digest=digest(decision),result=result),('result',))
 return {'decision':decision,'accepted_historical_ownership':result,'model_inference':False,'live_provider_qualification':False}


def apply_recovery(f,decision):
 """Actual authenticated production recovery action; returned state is never seeded."""
 status,response=f.invoke('fleet.install.admit',{'decision':decision},component='fleet-install',key='manager')
 return status,response
