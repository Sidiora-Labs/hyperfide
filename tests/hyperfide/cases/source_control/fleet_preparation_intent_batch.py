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
 const wrongRun=await within(d.other_run_id,async(tx,scope)=>{
  const single=await capture(()=>loadPreparationIntent(tx,{...scope,task_id:d.cases[0].task_id}));
  const bulk=await loadPreparationIntents(tx,{...scope,task_ids:[d.cases[0].task_id]});
  assert.equal(single.error_code,'TASK_UNAVAILABLE');assert.deepEqual(bulk,[{task_id:d.cases[0].task_id,error_code:'TASK_UNAVAILABLE'}]);return bulk;
 });
 console.log(JSON.stringify({status:'PASS',scope:'actual PostgreSQL and branded ResourceContainer primary transactions; accepted declarative preparation intent only',cases:d.cases.map((test,index)=>({name:test.name,...result[index]})),wrong_run:wrongRun,bounds:['empty accepted','duplicate refused INVALID_REQUEST','101 refused INVALID_REQUEST','100 unique retained in caller order'],query_count_claim:'NOT_CLAIMED',physical_readiness:'NOT_CLAIMED'}));
}finally{await resources.close();}
'''


def main():
    f = packet.PacketFixture(bootstrap=False, seed_historical_runtime=False)
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
        other_run = packet.uid()
        f.sql('INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch) SELECT organisation_id,$3,project_id,spec_revision_id,policy_digest,authority_epoch FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2', [i['organisation'], i['run'], other_run])
        data = {'organisation_id': i['organisation'], 'run_id': i['run'], 'other_run_id': other_run, 'epoch': i['epoch'], 'profile_id': i['profile'], 'preparation_digest': f.preparation, 'cases': cases, 'boundary_ids': [i['packet_task'], second] + [packet.uid() for _ in range(98)], 'extra_id': packet.uid()}
        result = subprocess.run(['node', '--input-type=module', '-e', SCRIPT], input=json.dumps(data), text=True, capture_output=True, cwd=ROOT, env=f.env, timeout=90)
        assert result.returncode == 0, result.stderr + result.stdout
        report = json.loads(result.stdout)
        assert report['status'] == 'PASS', report
        print(json.dumps(report))
    finally:
        f.close()


if __name__ == '__main__':
    main()
