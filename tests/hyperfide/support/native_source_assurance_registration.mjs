import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {createSourceS3Fixture} from '../cases/source_control/fixtures/objects/backend.mjs';

const config=JSON.parse(await fs.readFile(process.env.NATIVE_ASSURANCE_REGISTRATION_INPUT,'utf8')),i=config.ids;
const controlRoot=path.dirname(process.env.SOURCE_CONTROL_MODULE_ROOT),load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
const [{createResourceContainer},{AuthorityStore,lookupAuthorityActivation},{FileExternalAuthorityJournal},identityModule,protocol,{createSourceService},{S3SourceObjectBackend},{parseKvx},{sourceDigest,canonicalBytes},{nativeCandidateSourceDigest,nativeCandidateDependencyDigest}]=await Promise.all([
 load('storage/runtime'),load('storage/durability'),load('storage/authority_journal'),load('identity/enrollment'),load('transport/protocol'),load('source_control/registration'),load('source_control/s3'),load('spec/import'),load('source_control/contracts').then(async contract=>({...contract,...await load('source_control/metadata')})),load('source_control/candidates')]);
const signal=new AbortController().signal,resources=createResourceContainer({role:'control',env:process.env,signal});
const journal=new FileExternalAuthorityJournal(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,value=>lookupAuthorityActivation(resources,value));
const authority=new AuthorityStore(resources,process.env.HYPERFIDE_DEPLOYMENT_ID,journal);
const identity=await identityModule.createComponent({env:process.env,resources,signal,dependencies:{require(name,capability){assert.equal(name,'4.4');assert.equal(capability,'storage.authority.v1');return authority;}}});
const identityAuthority=identity.capabilities['identity.authority'],pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:12});
const backend=await createSourceS3Fixture(),working=await fs.mkdtemp(path.join(os.tmpdir(),'hf-native-assurance-register-'));
const scope={organisation_id:i.organisation,repository_id:i.repository,security_domain_id:randomUUID()},sourcePolicy='native-registration-v1',keys={};
for(const [name,filename]of Object.entries(config.keys))keys[name]=await fs.readFile(filename);
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const checks=[];
const service=createSourceService({pool,backend:new S3SourceObjectBackend(backend.config),cursorKey:randomBytes(32),workspaceBudgets:{cache_bytes:16777216,max_cache_entries:1024,max_file_bytes:8388608,materialized_bytes:33554432,dirty_bytes:8388608},transaction:body=>resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},body)});
function signed(body,key,url){const proof={id:i[key],time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};return {'content-type':'application/json','HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':sign(null,protocol.signingBytes(config.origin,url,proof,body),keys[key]).toString('base64url')};}
async function sourceInvocation(key,action,input,operation=randomUUID()){
 const value={protocol_version:1,scope,operation_id:operation,idempotency_key:operation,action,input},body=Buffer.from(JSON.stringify(value));
 return {value,invocation:await identityAuthority.authenticateSource(body,Object.entries(signed(body,key,'/api/v1/source-control')).flat(),signal)};
}
async function call(key,action,input,operation){const {value,invocation}=await sourceInvocation(key,action,input,operation);return service.api.invoke(action,value,invocation);}
async function control(key,component,action,input){
 const operation=randomUUID(),payload=Buffer.from(JSON.stringify({run_id:i.run,component,action,input,expected_version:null,authority:null}));
 const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:hash(payload),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')}));
 const headers=signed(body,key,'/v1/invoke');
 const invocation=await identityAuthority.authenticate(body,Object.entries(headers).flat(),signal);
 assert.equal(component,'14.1');return identity.actions[action](input,{env:process.env,resources,signal,invocation});
}
const expect=(code,callback)=>assert.rejects(callback,error=>error.code===code);
async function insert(table,record){const names=Object.keys(record);await pool.query('INSERT INTO hyperfide.'+table+'('+names.join(',')+') VALUES('+names.map((_,index)=>'$'+(index+1)).join(',')+')',Object.values(record));}
try{
 await insert('source_authority_domains',{...scope,authority_epoch:'1',policy_version:sourcePolicy});
 await service.metadata.registerRepository(scope,{authority_epoch:'1',policy_version:sourcePolicy,durability_profile:'owned-native-registration'});
 for(const name of ['operator','leader','manager'])await insert('source_capabilities',{...scope,id:randomUUID(),principal_id:i[name],credential_id:i[name],principal_kind:'automation',authority_epoch:'1',policy_version:sourcePolicy,actions:config.actions,path_prefixes:[''],expires_at:new Date(Date.now()+1200000).toISOString()});
 const file=await service.objects.putFile(scope,Buffer.from('candidate: registration\n'));
 const tree=(await service.trees.fromEntries(scope,[{name:'main.txt',kind:'file',mode:'100644',object_id:file.object_id}])).root_tree_id;
 const change=randomUUID(),revision=await call('operator','source.revisions.create',{change_id:change,root_tree_id:tree,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Native registration test',email:'native@example.invalid'},message:'Native registration source',timestamp:new Date().toISOString()}});
 await call('leader','source.fleet.bind-run',{run_id:i.run,revision_id:revision.revision_id,leader_generation:'1'});
 const checkerKey=generateKeyPairSync('ed25519');i.checker=randomUUID();keys.checker=checkerKey.privateKey;const actor=randomUUID();
 await control('operator','14.1','identity.service.issue',{credential_id:i.checker,actor_id:actor,role:'COORDINATOR',public_key_b64:checkerKey.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url'),allowed_actions:['source.objects.put','source.objects.read','source.assurance.publish','identity.principal.renew'],ttl_seconds:600});
 await call('operator','source.capabilities.manage',{operation:'grant',capability:{id:randomUUID(),principal_id:actor,credential_id:i.checker,principal_kind:'automation',authority_epoch:'1',policy_version:sourcePolicy,actions:['source.objects.put','source.objects.read','source.assurance.publish'],path_prefixes:[''],expires_at:new Date(Date.now()+540000).toISOString()}});
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM hyperfide.source_principal_credentials WHERE credential_id=$1',[i.checker])).rows[0].n,0);
 const script="const f=require('node:fs');if(f.readFileSync('main.txt','utf8')!=='candidate: registration\\n')process.exit(9);f.writeFileSync('proof.json',JSON.stringify({checked:true}));process.stdout.write('passed\\n');";
 const command={id:'native-registration',argv:[process.execPath,'-e',script],executable_digest:hash(await fs.readFile(process.execPath)),timeout_ms:30000,required_artifacts:['proof.json'],input_keys:['source','dependency','toolchain','configuration','graph','contract']};
 const rubric=sourceDigest('native-registration-rubric'),specification=randomUUID(),task=randomUUID();
 const current=(await pool.query('SELECT spec_generation::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[i.organisation,i.run])).rows[0];const generation=String(BigInt(current.spec_generation)+1n);
 let source='[req.4]\nac_1 = "Native checks bind accepted executable source."\n[acceptance.native-registration]\nreqs = ["4.1"]\nchecks = ["native-registration"]\n[proof]\nrubric_digest = '+JSON.stringify(rubric)+'\n[proof.check.native-registration]\n';
 for(const [key,value]of Object.entries(command))if(key!=='id')source+=key+' = '+JSON.stringify(value)+'\n';
 source+='[task.native-registration]\nwave = 1\nreqs = ["4.1"]\nacceptance_ids = ["native-registration"]\nrequires = []\ntouches = ["main.txt"]\n';
 const parsed=parseKvx(source),document={schema_version:1,revision_digest:hash(source),source_digest:hash(source),repositories:[{repository_id:i.repository,source_object_id:revision.revision_id,integration_ref:null}],allowed_actions:config.actions,closure_policy:{required_evidence:[],required_review_roles:[],publication:'AFTER_QUALIFICATION'},provenance:null,parsed,runtime_wave_offset:0};
 await insert('spec_revisions',{organisation_id:i.organisation,project_id:i.project,id:specification,source_digest:document.source_digest,source_content:source,document,schema_version:1,revision_digest:document.revision_digest});
 await insert('run_spec_revisions',{organisation_id:i.organisation,run_id:i.run,spec_generation:generation,spec_revision_id:specification});
 await pool.query('UPDATE hyperfide.runs SET spec_revision_id=$3,spec_generation=$4,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2',[i.organisation,i.run,specification,generation]);
 const criteria=sourceDigest('native-registration-criteria');
 await insert('tasks',{organisation_id:i.organisation,run_id:i.run,id:task,task_key:'alpha.native-registration',feature_package_id:i.package,spec_revision_id:specification,spec_generation:generation,criteria_digest:criteria,definition:{...config.definition,section:parsed.sections.find(section=>section.name==='task.native-registration'),touches:['main.txt']},wave:1});
 const proof={schema_version:1,criteria_digest:criteria,spec_revision_id:specification,spec_generation:generation,repository_id:i.repository,source_object_id:revision.revision_id,rubric_digest:rubric,checks:[command],clauses:[{id:'4.1',mode:'EXECUTABLE',acceptance_ids:['native-registration'],checks:[command.id]}],inputs:Object.fromEntries(command.input_keys.map(key=>[key,sourceDigest(key)])),contract_digests:[]};
 const runVersion=(await pool.query('SELECT state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[i.organisation,i.run])).rows[0].state_version;
 const {invocation:proofInvocation}=await sourceInvocation('operator','source.capabilities',{});
 const {registerProofPolicy}=await load('spec/obligations');
 const registered=await resources.gateway.withPrimaryTransaction({timeoutMs:15000},async tx=>{await proofInvocation.guard(tx);return registerProofPolicy(tx,{organisation_id:i.organisation,run_id:i.run},{run_id:i.run,task_id:task,spec_revision_id:specification,spec_generation:generation,state_version:runVersion,policy:proof});});
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM hyperfide.source_native_assurance_policies')).rows[0].n,0);
 const policyInput={policy_id:randomUUID(),run_id:i.run,task_id:task,spec_revision_id:specification,spec_generation:generation,expires_at:new Date(Date.now()+600000).toISOString()};
 await expect('ASSURANCE_REGISTRATION_DENIED',()=>call('manager','source.assurance.policy.register',policyInput));
 await expect('ASSURANCE_REGISTRATION_DENIED',()=>call('operator','source.assurance.policy.register',{...policyInput,run_id:randomUUID()}));
 await expect('INVALID_REQUEST',()=>call('operator','source.assurance.policy.register',{...policyInput,checks:[]}));
 await expect('INVALID_REQUEST',()=>call('operator','source.assurance.policy.register',{...policyInput,spec_generation:'9223372036854775808'}));
 const policyOp=randomUUID(),policy=await call('operator','source.assurance.policy.register',policyInput,policyOp);
 assert.equal(policy.policy_digest,registered.registry_digest);assert.deepEqual(await call('operator','source.assurance.policy.register',policyInput,policyOp),policy);
 const checkerInput={policy_id:policy.policy_id,check_id:command.id,credential_id:i.checker,expires_at:policy.expires_at};
 await expect('CHECKER_NOT_AUTHORIZED',()=>call('operator','source.assurance.checker.register',{...checkerInput,credential_id:i.manager}));
 const checker=await call('operator','source.assurance.checker.register',checkerInput);assert.equal(checker.principal_id,actor);assert.equal(checker.identity_kind,'NATIVE');
 checks.push('signed operator registration derives native policy from accepted executable proof and registers the actual issued native checker without a JWT shadow identity');
 const domain=await call('operator','source.domains.create',{domain_id:randomUUID(),revision_id:revision.revision_id,policy_id:policy.policy_id,policy_digest:policy.policy_digest});
 const custody=await call('operator','source.assurance.custody.create',{custody_id:randomUUID(),custody_generation:'1',revision_id:revision.revision_id});
 const candidate=await call('operator','source.candidates.create',{candidate_id:randomUUID(),domain_id:domain.domain_id,expected_generation:domain.generation,expected_revision_id:revision.revision_id,revision_id:revision.revision_id,contributors:[{revision_id:revision.revision_id,change_id:change,custody_id:custody.custody_id,custody_generation:'1'}],dependencies:[],inputs:{source:nativeCandidateSourceDigest(scope,revision.revision_id,tree),dependency:nativeCandidateDependencyDigest([]),toolchain:command.executable_digest,configuration:sourceDigest({LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}),graph:sourceDigest('graph'),contract:sourceDigest('contract')},transformation_version:'native-registration-v1'});
 await fs.writeFile(path.join(working,'main.txt'),await service.objects.readFile(scope,file.object_id));const started_at=new Date().toISOString();
 const processChild=spawn(command.argv[0],command.argv.slice(1),{cwd:working,env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['ignore','pipe','pipe']}),stdout=[],stderr=[];processChild.stdout.on('data',part=>stdout.push(part));processChild.stderr.on('data',part=>stderr.push(part));
 const observed=await new Promise((resolve,reject)=>{processChild.once('error',reject);processChild.once('close',(exit_code,signal)=>resolve({exit_code,signal}));});assert.equal(observed.exit_code,0);const finished_at=new Date().toISOString();let absent=false;try{process.kill(processChild.pid,0);}catch(error){if(error.code==='ESRCH')absent=true;else throw error;}assert(absent);
 const blob=async bytes=>(await call('checker','source.objects.put',{kind:'blob',payload_base64:Buffer.from(bytes).toString('base64')})).object_id;
 const receipt={schema_version:1,source_kind:'NATIVE',candidate_id:candidate.candidate_id,candidate_manifest_digest:candidate.manifest_digest,revision_id:revision.revision_id,root_tree_id:tree,inputs:candidate.inputs,check_id:command.id,command:{argv:command.argv,cwd:'.',executable_digest:command.executable_digest,environment_digest:sourceDigest({LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}),started_at,finished_at,...observed,timed_out:false,interrupted:false,output_truncated:false},execution:{execution_id:randomUUID(),source_revision_id:revision.revision_id,source_root_tree_id:tree,input_digest:sourceDigest(candidate.inputs),cleanup_complete:true,process_absent:true},output:{stdout_object_id:await blob(Buffer.concat(stdout)),stderr_object_id:await blob(Buffer.concat(stderr))},artifacts:[{path:'proof.json',object_id:await blob(await fs.readFile(path.join(working,'proof.json')))}]};
 const evidence=await call('checker','source.assurance.publish',{candidate_id:candidate.candidate_id,check_id:command.id,receipt_object_id:await blob(canonicalBytes(receipt))});assert.equal(evidence.outcome,'PASS');
 const oldInvocation=await sourceInvocation('checker','source.objects.read',{object_id:file.object_id});
 const renewed=await control('checker','14.1','identity.principal.renew',{ttl_seconds:600});assert.equal(renewed.credential_version,'2');
 await assert.rejects(()=>service.api.invoke(oldInvocation.value.action,oldInvocation.value,oldInvocation.invocation),error=>/^AUTH_/.test(error.code));
 const qualification=await call('operator','source.candidates.qualify',{candidate_id:candidate.candidate_id,evidence_ids:[evidence.evidence_id]});assert(qualification.qualification_id);
 await pool.query("UPDATE hyperfide.identity_principals SET expires_at=(SELECT created_at+interval '1 millisecond' FROM hyperfide.source_native_assurance_evidence WHERE evidence_id=$2) WHERE credential_id=$1",[i.checker,evidence.evidence_id]);
 await new Promise(resolve=>setTimeout(resolve,20));
 const afterExpiry=await call('operator','source.candidates.qualify',{candidate_id:candidate.candidate_id,evidence_ids:[evidence.evidence_id]});assert(afterExpiry.qualification_id);
 checks.push('real native checker executes the accepted command, signs its exact receipt, and historical proof survives authenticated renewal and ordinary credential expiry while the old invocation is fenced');
 await control('operator','14.1','identity.principal.revoke',{credential_id:i.checker,expected_version:'2'});
 await expect('CHECKER_NOT_AUTHORIZED',()=>call('operator','source.candidates.qualify',{candidate_id:candidate.candidate_id,evidence_ids:[evidence.evidence_id]}));
 checks.push('explicit native checker revocation invalidates current candidate evidence');
 const result={schema_version:1,status:'PASS',checks,native_checker_without_shadow_credentials:true,backend_requests:backend.requests.length};
 await fs.mkdir('build/source-control/assurance-registration',{recursive:true});await fs.writeFile('build/source-control/assurance-registration/receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await fs.rm(working,{recursive:true,force:true});await backend.close();await pool.end();await resources.close();}
