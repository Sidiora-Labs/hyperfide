#!/usr/bin/env python3
"""Registered runner capability checks; no provider or full-case qualification."""
from __future__ import annotations
import importlib.util,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
IDS=["runner.exports.registered","runner.exports.supervisor-guard","runner.exports.receipt-functions","runner.exports.reproduction-guard","runner.exports.receipt-valid","runner.exports.receipt-wrong-operation","runner.exports.receipt-wrong-uid","runner.exports.receipt-absent","runner.exports.stop-empty","runner.exports.stop-debt-not-complete","runner.exports.stop-inventory-refused","runner.exports.stop-stale-epoch","runner.exports.stop-unknown","runner.exports.stop-retained-report","runner.exports.stop-credential-residue","runner.exports.stop-output-debt","runner.exports.stop-later-command","runner.exports.control-resolves","runner.exports.finalize-resolves"]
IDS.insert(-2,'runner.exports.stop-stale-report')
FAILED=[]
def check(name,value,detail="unexpected observation"):
 actual="observed" if value else str(detail)
 if not value:FAILED.append(name)
 print(json.dumps({"type":"assertion","id":name,"expected":"observed","actual":actual}),flush=True)
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def closure(names):
 fragments={}
 for file in (ROOT/'services/hyperfide/components').glob('*.json'):
  fragment=json.loads(file.read_text())
  if 'id' in fragment:fragments[fragment['id']]=(file.stem,fragment)
 result=[];seen=set()
 def visit(name):
  if name in seen:return
  seen.add(name);stem,fragment=fragments[name]
  for dependency in fragment["requires"]:visit(dependency)
  result.append(stem)
 for name in names:visit(name)
 return result
PROBE=r"""
import fs from 'node:fs/promises';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {ComponentRegistry} from './services/hyperfide/dist/components/registry.js';
import {isSupervisor,supervisorCapability} from './services/hyperfide/dist/recovery/control.js';
import {registerReproductionJobInputs} from './services/hyperfide/dist/runner/reproduction_jobs.js';
import {verifyPreparationReceipt,recordPreparationReceipt,readPreparationReceipt} from './services/hyperfide/dist/runner/preparation_receipts.js';
import {hash,signingBytes} from './services/hyperfide/dist/transport/protocol.js';
const data=JSON.parse(process.env.HF_RUNNER_EXPORT_FIXTURE),controller=new AbortController();
const registry=new ComponentRegistry({role:'control',policy:JSON.parse(await fs.readFile(data.policy,'utf8')),signal:controller.signal,env:process.env});
const out={};const digest='sha256:'+'a'.repeat(64);
const refused=async(fn,code)=>{try{await fn();return false}catch(e){return e.code===code}};
try{
 await registry.load(data.components,process.cwd()+'/services/hyperfide/dist');
 out.registered=['12.4','24.1','24.3'].every(id=>registry.hasComponent(id));
 const dependencies={require:(id,name,guard)=>registry.resolveCapability(id,name,guard)};
 const supervisors=supervisorCapability({dependencies});
 out['supervisor-guard']=isSupervisor(supervisors)&&typeof supervisors.verifyStop==='function';
 const receipts=registry.resolveCapability('12.4','runner.preparation-receipts.v1',v=>!!v&&typeof v.read==='function');
 out['receipt-functions']=receipts.verify===verifyPreparationReceipt&&receipts.record===recordPreparationReceipt&&receipts.readReceipt===readPreparationReceipt;
 let registered=false,reader;
 const off=registerReproductionJobInputs({dependencies:{require:(id,name,guard)=>id==='12.1'?{registerInputReader:(namespace,fn)=>{registered=namespace==='REPRODUCTION';reader=fn;return()=>{registered=false}}}:dependencies.require(id,name,guard)}},async()=>null);
 const authority=registry.resolveCapability('14.1','identity.authority',v=>!!v&&typeof v.authenticate==='function');
 const payload=Buffer.from(JSON.stringify({run_id:data.scope.run_id,component:'14.1',action:'identity.describe',input:{},expected_version:null,authority:null}));
 const op=randomUUID(),body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:op,idempotency_key:op,payload_digest:hash(payload),correlation_id:op,causation_id:null,payload_b64:payload.toString('base64url')}));
 const proof={id:data.credential,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()},key=createPrivateKey(await fs.readFile(data.key));
 const signature=sign(null,signingBytes(data.origin,'/v1/invoke',proof,body),key).toString('base64url');
 const invocation=await authority.authenticate(body,['hf-credential-id',proof.id,'hf-request-time',proof.time,'hf-request-nonce',proof.nonce,'hf-request-signature',signature],controller.signal);
 await authority.authorize(invocation);
 const gateway=registry.resolveCapability('4.2','storage.transactions.v1',v=>!!v&&typeof v.withPrimaryTransaction==='function');
 off();
 const request={job_namespace:'REPRODUCTION',job_id:randomUUID(),lease_generation:'1',reservation_id:randomUUID(),input_manifest_digest:digest,environment_digest:digest};
 const stopReader=registerReproductionJobInputs({dependencies:{require:(id,name,guard)=>id==='12.1'?{registerInputReader:(_namespace,fn)=>{reader=fn;return()=>{}}}:dependencies.require(id,name,guard)}},async()=>request);
 // The real consumer reaches the exported read implementation and then refuses
 // this operator's nonexistent semantic job, rather than a missing capability.
 out['reproduction-guard']=registered===false&&await refused(()=>gateway.withPrimaryTransaction({timeoutMs:5000},tx=>reader(tx,invocation,request)),'REPRODUCTION_INPUT_AUTHORITY_DENIED');stopReader();
 const operation=randomUUID(),root='/run/hyperfide-stage/'+operation;
 const plan={operation_id:operation,plan_digest:digest,argv:['/usr/bin/node','/opt/prepare.mjs','--job-context',root+'/context.json'],executable_digest:digest,uid:1001,gid:1001,workspace_path:'/workspace'};
 const receipt={execution_plane:'REMOTE',operation_id:operation,plan_digest:digest,executable_digest:digest,preparation_stage:{stage_root:root,context_path:root+'/context.json',out_root:root+'/out',diagnostics_root:root+'/diagnostics',workspace_path:'/workspace',node_path:plan.argv[0],recipe_path:plan.argv[1],context_digest:digest,node_digest:digest,recipe_digest:digest,uid:1001,gid:1001}};
 const bytes=Buffer.from(JSON.stringify(receipt));
 out['receipt-valid']=receipts.verify(bytes,plan).stage.uid===1001;
 out['receipt-wrong-operation']=await refused(()=>receipts.verify(bytes,{...plan,operation_id:randomUUID()}),'PREPARATION_RECEIPT_MISMATCH');
 out['receipt-wrong-uid']=await refused(()=>receipts.verify(bytes,{...plan,uid:1002}),'PREPARATION_RECEIPT_MISMATCH');
 out['receipt-absent']=await gateway.withPrimaryTransaction({timeoutMs:5000},tx=>receipts.readReceipt(tx,{...data.scope,operation_id:randomUUID()}))===null;
 const input={scope:data.scope,operation_id:data.operation,scope_kind:'RUN',scope_id:data.scope.run_id,commands:[]};
 const empty=await supervisors.verifyStop(input);
 out['stop-empty']=empty.cleanup_complete&&empty.processes_stopped&&empty.artifacts_preserved&&empty.credentials_cleared&&empty.resources_reconciled&&/^sha256:[a-f0-9]{64}$/.test(empty.evidence_digest)&&Number.isFinite(Date.parse(empty.observed_at));
 await gateway.withPrimaryTransaction({timeoutMs:5000},tx=>tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,command_id,desired_state,detail) VALUES($1,$2,$3,'SUPERVISOR',$4,$5,'STOPPED','Missing authenticated runner report fixture')",[data.scope.organisation_id,data.scope.run_id,data.operation,data.session,data.command]));
 const command={session_id:data.session,command_id:data.command,generation:'1'},pending=await supervisors.verifyStop({...input,commands:[command]});
 out['stop-debt-not-complete']=pending.cleanup_complete===false&&pending.processes_stopped===false&&pending.artifacts_preserved===false&&pending.credentials_cleared===false&&pending.resources_reconciled===false&&pending.evidence_digest!==empty.evidence_digest;
 out['stop-inventory-refused']=await refused(()=>supervisors.verifyStop(input),'RECOVERY_INPUT_INVALID');
 out['stop-stale-epoch']=await refused(()=>supervisors.verifyStop({...input,scope:{...data.scope,authority_epoch:randomUUID()}}),'RECOVERY_STALE_EPOCH');
 const unknown=await supervisors.stop({scope:data.scope,...command});
 out['stop-unknown']=unknown.status==='UNKNOWN'&&/^sha256:[a-f0-9]{64}$/.test(unknown.evidence_digest);
 // Controlled retained-state fixture: these rows model reports already accepted
 // by runner control. Physical native behaviour is covered by the owning12.4 probe.
 const slot=randomUUID(),launch=randomUUID(),attempt=randomUUID();
 const values=[data.scope.organisation_id,data.scope.run_id,data.command,data.session,slot,launch,attempt,data.sandbox,data.boot,data.credential,data.scope.authority_epoch,digest];
 const sql=async(text)=>gateway.withPrimaryTransaction({timeoutMs:5000},tx=>tx.query('WITH fixture_bindings AS (SELECT '+values.map((_,i)=>'$'+(i+1)+'::'+(i===11?'text':'uuid')+' AS v'+i).join(',')+') '+text,values));
 await sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$5,$8,'retained-report-fixture',1,'TEST')");
 await sql("INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,launch_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,boot_preparation_digest,preparation_digest,slot_generation,uid,gid,observation_digest,state) VALUES($1,$2,$4,$10,$8,1,$9,$5,$6,'/fixture/state','/fixture/native','/fixture/work','/fixture/home','/fixture/tmp',$12,$12,$12,1,1001,1001,$12,'REVOKED')");
 await sql("INSERT INTO hyperfide.runner_control_commands(organisation_id,run_id,command_id,action,launch_id,slot_id,sandbox_id,boot_id,boot_generation,attempt_id,attempt_generation,authority_epoch,fence_sequence,policy,required_outputs,request_digest,issued_by_credential_id,state,outcome,termination,cleanup_complete,report,report_digest,reported_at) VALUES($1,$2,$3,'runner.stop',$6,$5,$8,$9,1,$7,1,$11,1,'{}','[]',$12,$10,'REPORTED','STOPPED','CONFIRMED',true,'{\"remaining_descendants\":0,\"credential_revocation\":[],\"cleanup_complete\":true}',$12,clock_timestamp())");
 await sql("INSERT INTO hyperfide.runner_workspaces(organisation_id,run_id,sandbox_id,boot_generation,slot_id,slot_generation,state,process_residue,credential_residue,outputs_durable,registered_by_credential_id) VALUES($1,$2,$8,1,$5,1,'FREE','ABSENT','ABSENT',true,$10)");
 await sql("UPDATE hyperfide.recovery_resource_debts SET status='RESOLVED',resolved_at=clock_timestamp(),observed_at=clock_timestamp(),evidence_digest=$12 WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3");
 const reported=await supervisors.verifyStop({...input,commands:[command]});
 out['stop-retained-report']=reported.cleanup_complete===true&&(await supervisors.stop({scope:data.scope,...command})).status==='CONFIRMED_STOPPED';
 await sql("UPDATE hyperfide.runner_control_commands SET reported_at=clock_timestamp()-interval '1 hour' WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3");
 out['stop-stale-report']=(await supervisors.verifyStop({...input,commands:[command]})).cleanup_complete===false;
 await sql("UPDATE hyperfide.runner_control_commands SET reported_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3");
 await sql("UPDATE hyperfide.runner_workspaces SET updated_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND slot_id=$5");
 await sql("UPDATE hyperfide.runner_workspaces SET credential_residue='PRESENT' WHERE organisation_id=$1 AND run_id=$2 AND slot_id=$5");
 const residue=await supervisors.verifyStop({...input,commands:[command]});
 out['stop-credential-residue']=residue.credentials_cleared===false&&residue.cleanup_complete===false&&residue.processes_stopped===true;
 await sql("UPDATE hyperfide.runner_workspaces SET credential_residue='ABSENT',outputs_durable=false WHERE organisation_id=$1 AND run_id=$2 AND slot_id=$5");
 const outputDebt=await supervisors.verifyStop({...input,commands:[command]});
 out['stop-output-debt']=outputDebt.artifacts_preserved===false&&outputDebt.cleanup_complete===false;
 await sql("INSERT INTO hyperfide.runner_control_commands(organisation_id,run_id,command_id,action,launch_id,slot_id,sandbox_id,boot_id,boot_generation,attempt_id,attempt_generation,authority_epoch,fence_sequence,policy,required_outputs,request_digest,issued_by_credential_id) VALUES($1,$2,gen_random_uuid(),'runner.stop',$6,$5,$8,$9,1,$7,1,$11,2,'{}','[]',$12,$10)");
 out['stop-later-command']=(await supervisors.stop({scope:data.scope,...command})).status==='UNKNOWN'&&(await supervisors.verifyStop({...input,commands:[command]})).cleanup_complete===false;
 console.log(JSON.stringify(out));
}finally{controller.abort();await registry.close()}
"""
def main():
 fixture=None;complete=False
 try:
  identity=load('runner_export_identity','tests/hyperfide/support/identity_fixture.py')
  operation,session,command=(str(uuid.uuid4()) for _ in range(3))
  def setup(f):
   i=f.ids
   f.sql("INSERT INTO hyperfide.recovery_operations(organisation_id,run_id,operation_id,kind,input_digest,authority_epoch,state,result) VALUES($1,$2,$3,'STOP',$4,$5,'APPLIED',$6)",[i['organisation'],i['run'],operation,'sha256:'+'a'*64,i['epoch'],{'scope_kind':'RUN','scope_id':i['run']}])
  fixture=identity.IdentityFixture(extra_components=closure(['12.4','24.1','24.3']),extra_setup=setup)
  i=fixture.ids;scope={'organisation_id':i['organisation'],'run_id':i['run'],'authority_epoch':i['epoch']}
  data={'policy':str(fixture.policy),'components':str(fixture.components),'scope':scope,'operation':operation,'session':session,'command':command,'credential':i['operator'],'key':str(fixture.keys['operator']['path']),'origin':fixture.origin,'sandbox':i['sandbox'],'boot':i['boot']}
  process=subprocess.run(['node','--input-type=module'],input=PROBE,text=True,capture_output=True,cwd=ROOT,env={**fixture.env,'HF_RUNNER_EXPORT_FIXTURE':json.dumps(data)},timeout=60)
  if process.returncode:raise AssertionError(process.stderr[-3000:])
  observed=json.loads(process.stdout)
  for name in IDS[:-2]:check(name,observed.get(name.removeprefix('runner.exports.')) is True,observed)
  response=fixture.invoke('recovery.control.describe',{},component='24.1')[1]
  check(IDS[-2],response.get('ok') is True and response['result']['supervisor_capability']=='PRESENT',response)
  response=fixture.invoke('recovery.stop.finalize',{'scope':scope,'operation_id':operation},component='24.3')[1]
  check(IDS[-1],response.get('ok') is True,response)
 finally:
  if fixture:fixture.close()
  complete=True
  print(json.dumps({'type':'cleanup','complete':complete,'resources':[]}),flush=True)
 return 1 if FAILED else 0
if __name__=='__main__':raise SystemExit(main())
