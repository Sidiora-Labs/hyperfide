#!/usr/bin/env python3
"""Real primary-gateway parity for accepted preparation intent batch reads; no physical readiness claim."""
import copy
import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('batch_packet_fixture', ROOT / 'tests/hyperfide/cases/tasks/3_2.py')
packet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packet)

SCRIPT = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {readSemanticDisposition} from './core/control-plane/dist/storage/dispositions.js';
import {loadPreparationIntent,loadPreparationIntents} from './core/control-plane/dist/hierarchy/packets.js';
import {jobPolicy} from './core/control-plane/dist/scheduler/claim.js';
import {parseKvx,taskDefinitions} from './core/control-plane/dist/spec/import.js';
const d=JSON.parse(fs.readFileSync(0,'utf8'));
const resources=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});
async function within(run,fn){
 const scope={organisation_id:d.organisation_id,run_id:run};
 return resources.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:2,guard:async tx=>{
  await readSemanticDisposition(tx,scope);
  const row=(await tx.query('SELECT authority_epoch::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,run])).rows[0];
  assert.equal(row?.authority_epoch,d.epoch);
 }},tx=>fn(tx,scope));
}
async function capture(fn){try{return {value:await fn()};}catch(error){return {error_code:error.code??'UNEXPECTED_ERROR'};}}
try{
 const result=await within(d.run_id,async(tx,scope)=>{
  const rows=await loadPreparationIntents(tx,{...scope,task_ids:d.cases.map(row=>row.task_id)});
  assert.deepEqual(rows.map(row=>row.task_id),d.cases.map(row=>row.task_id));
  for(const [index,test] of d.cases.entries()){
   const single=await capture(()=>loadPreparationIntent(tx,{...scope,task_id:test.task_id}));
   const bulk=rows[index];
   if(test.error_code){assert.equal(single.error_code,test.error_code,test.name);assert.deepEqual(bulk,{task_id:test.task_id,error_code:test.error_code},test.name);}
   else{assert.ok(single.value,test.name+JSON.stringify(single));assert.deepEqual(bulk,{task_id:test.task_id,intent:single.value},test.name);assert.equal(bulk.intent.execution_authority,false);assert.equal(bulk.intent.spec_revision_id,test.spec_revision_id);assert.equal(bulk.intent.spec_generation,test.spec_generation);assert.equal(bulk.intent.profile_id,d.profile_id);assert.equal(bulk.intent.preparation_digest,d.preparation_digest);}
  }
  assert.deepEqual(await loadPreparationIntents(tx,{...scope,task_ids:[]}),[]);
  const duplicate=await capture(()=>loadPreparationIntents(tx,{...scope,task_ids:[d.cases[0].task_id,d.cases[0].task_id]}));assert.equal(duplicate.error_code,'INVALID_REQUEST');
  const oversized=await capture(()=>loadPreparationIntents(tx,{...scope,task_ids:d.boundary_ids.concat(d.extra_id)}));assert.equal(oversized.error_code,'INVALID_REQUEST');
  const boundary=await loadPreparationIntents(tx,{...scope,task_ids:d.boundary_ids});assert.equal(boundary.length,100);assert.deepEqual(boundary.map(row=>row.task_id),d.boundary_ids);
  for(const [index,row]of boundary.entries())if(index<2)assert.ok(row.intent);else assert.deepEqual(row,{task_id:d.boundary_ids[index],error_code:'TASK_UNAVAILABLE'});
  return rows;
 });
 const crossProfile=await within(d.run_id,async(tx,scope)=>{
  const out=[];
  for(const test of d.qualification_cases){
   const coding=await capture(()=>loadPreparationIntent(tx,{...scope,task_id:test.task_id}));
   if(test.coding_error)assert.equal(coding.error_code,test.coding_error,test.name);else assert.equal(coding.value.profile_id,test.coding_profile_id,test.name);
   const single=await capture(()=>loadPreparationIntent(tx,{...scope,task_id:test.task_id,purpose:'QUALIFICATION'}));
   const [bulk]=await loadPreparationIntents(tx,{...scope,task_ids:[test.task_id],purpose:'QUALIFICATION'});
   if(test.error_code){assert.equal(single.error_code,test.error_code,test.name);assert.equal(bulk.error_code,test.error_code,test.name);}
   else{assert.equal(single.value.profile_id,test.profile_id,test.name);assert.deepEqual(bulk.intent,single.value,test.name);if(test.independent){assert.deepEqual(single.value.declared_profile.credential_references,[]);if(!test.coding_error)assert.deepEqual(coding.value.declared_profile.credential_references,['secret-ref:fixture-gateway']);}}
   out.push({name:test.name,coding_profile_id:coding.value?.profile_id??null,coding_error:coding.error_code??null,qualification_profile_id:single.value?.profile_id??null,qualification_error:single.error_code??null});
  }
  const task_id=d.expired_coding_task;
  for(const job_kind of ['TEST','PREPARATION']){const policy=await jobPolicy(tx,scope,task_id,'ADMISSION',{job_kind,pool_id:d.qualification_pool_id});assert.equal(policy.cpu_millis,1000);}
  assert.equal((await capture(()=>jobPolicy(tx,scope,task_id,'ADMISSION',{job_kind:'PREPARATION',pool_id:d.coding_pool_id}))).error_code,'ENVIRONMENT_PROFILE_EXPIRED');
  for(const job_kind of ['TEST','PREPARATION'])assert.equal((await capture(()=>jobPolicy(tx,scope,task_id,'ADMISSION',{job_kind,pool_id:d.unrelated_pool_id}))).error_code,'ENVIRONMENT_PROFILE_MISMATCH');
  assert.equal((await capture(()=>jobPolicy(tx,scope,task_id,'ADMISSION',{job_kind:'TEST',pool_id:d.coding_pool_id}))).error_code,'ENVIRONMENT_PROFILE_MISMATCH');
  for(const raw of ['null','""','"not-a-uuid"'])assert.throws(()=>taskDefinitions(parseKvx('[task.selector]\nqualification_environment_profile_id = '+raw+'\n')),error=>error.code==='SPEC_INVALID');
  assert.equal(taskDefinitions(parseKvx('[task.selector]\nqualification_environment_profile_id = "'+d.qualification_profile_id+'"\n'))[0].section.fields.qualification_environment_profile_id.value,d.qualification_profile_id);
  return out;
 });
 const wrongRun=await within(d.other_run_id,async(tx,scope)=>{
  const single=await capture(()=>loadPreparationIntent(tx,{...scope,task_id:d.cases[0].task_id}));
  const bulk=await loadPreparationIntents(tx,{...scope,task_ids:[d.cases[0].task_id]});
  assert.equal(single.error_code,'TASK_UNAVAILABLE');assert.deepEqual(bulk,[{task_id:d.cases[0].task_id,error_code:'TASK_UNAVAILABLE'}]);return bulk;
 });
 console.log(JSON.stringify({status:'PASS',scope:'actual PostgreSQL and branded ResourceContainer primary transactions; accepted declarative preparation intent only',cases:d.cases.map((test,index)=>({name:test.name,...result[index]})),wrong_run:wrongRun,qualification_profiles:crossProfile,qualification_job_policy:'TEST and independent TEST-pool PREPARATION accept valid qualification profile while coding profile is expired',bounds:['empty accepted','duplicate refused INVALID_REQUEST','101 refused INVALID_REQUEST','100 unique retained in caller order'],query_count_claim:'NOT_CLAIMED',physical_readiness:'NOT_CLAIMED'}));
}finally{await resources.close();}
'''


def main():
    f = packet.PacketFixture(extra_components=("5.4",), bootstrap=True, seed_historical_runtime=False)
    try:
        i = f.ids
        cases = [{'name': 'accepted-revision-2', 'task_id': i['packet_task'], 'spec_revision_id': i['packet_spec'], 'spec_generation': '2'}]
        revision, section, criteria = packet.accept_spec(f, 3, 'A revised accepted task SHALL preserve exact independent preparation pins.')

        def negative(name, task, error):
            cases.append({'name': name, 'task_id': task, 'error_code': error})

        negative('missing-proof-registry', f.insert_task('alpha.batch-no-registry', f.task_definition()), 'PROOF_REGISTRY_MISSING')
        mismatch = f.insert_task('alpha.batch-bad-registry', f.task_definition())
        f.sql('INSERT INTO hyperfide.proof_registries(organisation_id,run_id,task_id,spec_generation,spec_revision_id,criteria_digest,registry_digest,policy) VALUES($1,$2,$3,2,$4,$5,$6,$7)', [i['organisation'], i['run'], mismatch, i['packet_spec'], f.packet_criteria, packet.sha(b'independently wrong registry digest'), json.dumps(f.packet_proof)])
        negative('mismatched-registry-digest', mismatch, 'PROOF_REGISTRY_MISMATCH')
        negative('missing-environment-profile', f.accepted_task('alpha.batch-no-profile', environment_profile_id=packet.uid()), 'ENVIRONMENT_PROFILE_REQUIRED')
        manifest = copy.deepcopy(f.sql('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2', [i['organisation'], i['profile']])[0]['manifest'])
        expired = packet.uid()
        manifest['profile']['profile_id'] = expired
        manifest['profile']['policy']['expires_at'] = '2020-01-01T00:00:00.000Z'
        manifest.pop('digest')
        manifest['digest'] = packet.identity(manifest)
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'fixture','linux',$4)", [i['organisation'], expired, manifest['digest'], json.dumps(manifest)])
        negative('expired-environment-profile', f.accepted_task('alpha.batch-expired-profile', environment_profile_id=expired), 'ENVIRONMENT_PROFILE_EXPIRED')
        definition = f.task_definition()
        definition.pop('execution_profile')
        no_execution = f.insert_task('alpha.batch-no-execution', definition)
        f.register_proof(no_execution, f.packet_proof)
        negative('missing-execution-profile', no_execution, 'EXECUTION_PROFILE_REQUIRED')
        packet.move_run(f, 3, revision, 'RUNNING')
        second = f.insert_task('alpha.batch-generation3', f.task_definition(section=section), criteria=criteria, generation=3, spec=revision)
        f.register_proof(second, f.proof_policy(criteria, generation=3, spec=revision))
        cases.insert(1, {'name': 'accepted-revision-3', 'task_id': second, 'spec_revision_id': revision, 'spec_generation': '3'})
        def declared_profile(name, references, expired=False):
            profile = copy.deepcopy(f.sql('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2', [i['organisation'], i['profile']])[0]['manifest'])
            identity = packet.uid()
            profile['profile']['profile_id'] = identity
            profile['profile']['profile_version'] = name
            profile['profile']['credential_references'] = references
            if expired:
                profile['profile']['policy']['expires_at'] = '2020-01-01T00:00:00.000Z'
            profile.pop('digest')
            profile['digest'] = packet.identity(profile)
            f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'fixture','linux',$4)", [i['organisation'], identity, profile['digest'], json.dumps(profile)])
            return identity
        coding_profile = declared_profile('coding-with-gateway', ['secret-ref:fixture-gateway'])
        qualification_profile = declared_profile('independent-test', [])
        def qualification_task(name, coding=coding_profile, **fields):
            task = f.insert_task('alpha.qualification-' + name, f.task_definition(environment_profile_id=coding, **fields), criteria=criteria, generation=3, spec=revision)
            f.register_proof(task, f.proof_policy(criteria, generation=3, spec=revision))
            return task
        qualification_cases = []
        def selection_case(name, **fields):
            task = qualification_task(name, **fields)
            qualification_cases.append({'name': name, 'task_id': task, 'coding_profile_id': coding_profile, 'profile_id': qualification_profile, 'independent': True})
            return qualification_cases[-1]
        selection_case('independent-test', qualification_environment_profile_id=qualification_profile)
        legacy = selection_case('legacy-absence')
        legacy.update(profile_id=coding_profile, independent=False)
        for name, value in [('explicit-null', None), ('explicit-empty', ''), ('explicit-malformed', 'not-a-uuid')]:
            case = selection_case(name, qualification_environment_profile_id=value)
            case['error_code'] = 'INVALID_REQUEST'
        case = selection_case('unregistered-test', qualification_environment_profile_id=packet.uid())
        case['error_code'] = 'ENVIRONMENT_PROFILE_REQUIRED'
        case = selection_case('expired-test', qualification_environment_profile_id=expired)
        case['error_code'] = 'ENVIRONMENT_PROFILE_EXPIRED'
        expired_coding = selection_case('expired-coding-independent-test', coding=expired, qualification_environment_profile_id=qualification_profile)
        expired_coding['coding_error'] = 'ENVIRONMENT_PROFILE_EXPIRED'
        qualification_pool, coding_pool, unrelated_pool = packet.uid(), packet.uid(), packet.uid()
        for pool, profile in [(qualification_pool, qualification_profile), (coding_pool, expired), (unrelated_pool, i['profile'])]:
            f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'fixture','fixture','fixture','fixture',$3)", [i['organisation'], pool, profile])
        accounts = {}
        for pool in [qualification_pool, unrelated_pool]:
            f.sql('INSERT INTO hyperfide.scheduling_policies(organisation_id,pool_id) VALUES($1,$2)', [i['organisation'], pool])
            accounts[pool] = {}
            for dimension, limit in [('CPU_MILLIS', '8000'), ('MEMORY_BYTES', '17179869184'), ('DISK_BYTES', '34359738368'), ('TEST', '2'), ('PREPARATION', '2')]:
                account = packet.uid()
                f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,provenance_digest,qualification_state) VALUES($1,$2,$3,$4,'EXECUTION',$5,$6,'QUALIFIED')", [i['organisation'], account, pool, dimension, limit, packet.sha(b'controlled component capacity input')])
                accounts[pool][dimension] = account
        queue_observations = []
        def queue_request(pool, kind):
            quantities = {'CPU_MILLIS': '1000', 'MEMORY_BYTES': '2147483648', 'DISK_BYTES': '4294967296', kind: '1'}
            return {'organisation_id': i['organisation'], 'run_id': i['run'], 'request_id': packet.uid(), 'pool_id': pool, 'job_kind': kind, 'priority': 0, 'wait_reason': 'CAPACITY', 'deadline_ms': 60000, 'dimensions': [{'capacity_account_id': accounts[pool][dimension], 'quantity': quantity} for dimension, quantity in quantities.items()], 'authority_epoch': i['epoch'], 'leader_generation': '1', 'package_generation': '2', 'task_id': expired_coding['task_id'], 'package_id': i['package2']}
        before = f.sql('SELECT (SELECT count(*) FROM hyperfide.resource_waiters WHERE organisation_id=$1 AND run_id=$2)::text AS waiters,(SELECT count(*) FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2)::text AS reservations', [i['organisation'], i['run']])
        for kind in ['TEST', 'PREPARATION']:
            rejected = f.invoke('scheduler.resources.queue', queue_request(unrelated_pool, kind), component='5.4', key='manager')[1]
            assert rejected.get('ok') is False and rejected['error']['code'] == 'ENVIRONMENT_PROFILE_MISMATCH', rejected
            queue_observations.append({'kind': kind, 'wrong_pool_code': rejected['error']['code']})
        after = f.sql('SELECT (SELECT count(*) FROM hyperfide.resource_waiters WHERE organisation_id=$1 AND run_id=$2)::text AS waiters,(SELECT count(*) FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2)::text AS reservations', [i['organisation'], i['run']])
        assert before == after, (before, after)
        for kind in ['TEST', 'PREPARATION']:
            queued = f.invoke('scheduler.resources.queue', queue_request(qualification_pool, kind), component='5.4', key='manager')[1]
            assert queued.get('ok') is True, queued
            queue_observations.append({'kind': kind, 'accepted_waiter_id': queued['result']['waiter_id']})
        other_run = packet.uid()
        f.sql('INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch) SELECT organisation_id,$3,project_id,spec_revision_id,policy_digest,authority_epoch FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2', [i['organisation'], i['run'], other_run])
        data = {'organisation_id': i['organisation'], 'run_id': i['run'], 'other_run_id': other_run, 'epoch': i['epoch'], 'profile_id': i['profile'], 'preparation_digest': f.preparation, 'cases': cases, 'qualification_cases': qualification_cases, 'qualification_profile_id': qualification_profile, 'expired_coding_task': expired_coding['task_id'], 'qualification_pool_id': qualification_pool, 'coding_pool_id': coding_pool, 'unrelated_pool_id': unrelated_pool, 'boundary_ids': [i['packet_task'], second] + [packet.uid() for _ in range(98)], 'extra_id': packet.uid()}
        result = subprocess.run(['node', '--input-type=module', '-e', SCRIPT], input=json.dumps(data), text=True, capture_output=True, cwd=ROOT, env=f.env, timeout=90)
        assert result.returncode == 0, result.stderr + result.stdout
        report = json.loads(result.stdout)
        report['signed_queue_profile_boundaries'] = queue_observations
        report['wrong_pool_waiters_and_reservations_unchanged'] = True
        assert report['status'] == 'PASS', report
        print(json.dumps(report))
    finally:
        f.close()


if __name__ == '__main__':
    main()
