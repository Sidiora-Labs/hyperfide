import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
import {CampaignState,executePersistentWorkload} from '../source-control/workloads/durable.mjs';
import {OperationLedger} from '../source-control/workloads/campaign.mjs';
const plan={schema_version:1,kind:'component',seed:42,file_counts:[10],modified_files:1,modified_bytes:32,clients:1,operations:1,rate_per_second:1,duration_seconds:1,hardware_digest:'sha256:'+'0'.repeat(64),backend_identity:'owned-fixture',real_backend:false};
if(process.argv[2]==='worker'){
 const config=JSON.parse(await fs.readFile(process.argv[3],'utf8')),{SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
 const client=new SourceControlClient({endpoint:config.endpoint,scope:config.scope,token:config.token}),state=new CampaignState(path.join(config.directory,'state.sqlite'),{plan}),ledger=new OperationLedger(path.join(config.directory,'operations.jsonl')),controller=new AbortController();
 try{
  await executePersistentWorkload({manifest:plan,client,workspaces:[config.workspace],state,corpus:10,ledger,signal:controller.signal,edit:async({operation_id,saved})=>{
   const request=saved.request??{operation_id,workspace_id:config.workspace.workspace_id,expected_workspace_generation:config.workspace.workspace_generation,expected_scope_generation:config.workspace.scope_generation,base_revision_id:config.workspace.base_revision_id,overlay_generation:'1',changes:config.changes};state.request(10,0,request);
   const result=saved.result??await client.call('source.workspaces.checkpoint',request,{operation_id,idempotency_key:operation_id});
   if(process.argv[4]==='kill')process.kill(process.pid,'SIGKILL');if(process.argv[4]==='pause'){controller.abort(new Error('Owned campaign pause after checkpoint acknowledgement'));throw controller.signal.reason;}state.result(10,0,result);return result;
  }});
 }catch(error){if(process.argv[4]!=='pause'||error!==controller.signal.reason)throw error;}finally{ledger.close();state.close();}
}else{
 const f=await createNativeAcceptanceFixture({actions:['source.operations.read','source.objects.put','source.objects.read','source.domains.create','source.revisions.create','source.revisions.read','source.workspaces.open','source.workspaces.detail','source.workspaces.close','source.workspaces.checkpoint']}),directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-resume-'));
 try{
  const file=await f.service.objects.putFile(f.scope,Buffer.from('resumed actual source checkpoint'));
  const workspace=(await f.mutation('source.workspaces.open',{workspace_id:globalThis.crypto.randomUUID(),base_revision_id:f.base.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:['']})).workspace;
  const config={endpoint:f.endpoint,scope:f.scope,token:f.tokenFor(),directory,workspace,changes:[{path:'main.txt',operation:'put',kind:'file',mode:'100644',object_id:file.object_id}]},filename=path.join(directory,'input.json');await fs.writeFile(filename,JSON.stringify(config),{mode:0o600});
  const run=mode=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve('tests/hyperfide/support/native_source_campaign_resume.mjs'),'worker',filename,...(mode?[mode]:[])],{env:process.env,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',bytes=>error+=bytes);child.on('error',reject);child.on('exit',(code,signal)=>mode==='kill'&&signal==='SIGKILL'||mode!=='kill'&&code===0?resolve():reject(Error(error)));});
  await run('kill');await run('pause');const count=async()=>(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_revisions')).rows[0].n;assert.equal(await count(),2);await run();await run();assert.equal(await count(),2);
  const ledger=new OperationLedger(path.join(directory,'operations.jsonl'));assert.equal(ledger.summary().new_revisions,1);assert.equal(ledger.summary().acknowledged,1);assert.equal(ledger.summary().rejected,0);assert.equal(ledger.summary().interrupted_attempts,1);ledger.close();
  const current=(await f.client.call('source.workspaces.detail',{workspace_id:workspace.workspace_id})).workspace;await f.mutation('source.workspaces.close',{workspace_id:current.workspace_id,expected_workspace_generation:current.workspace_generation});
  console.log(JSON.stringify({status:'PASS',checks:['actual HTTP checkpoint survives worker SIGKILL after server commit and resumes the exact operation without another revision','durable campaign ordinal and ledger reopen do not duplicate acknowledged work','graceful cancellation after a real committed checkpoint preserves an interrupted attempt and resumes without a permanent refusal']}));
 }finally{await f.close();await fs.rm(directory,{recursive:true,force:true});}
}
