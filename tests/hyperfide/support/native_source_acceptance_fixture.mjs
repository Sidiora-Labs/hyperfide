import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {createSourceS3Fixture} from '../cases/source_control/fixtures/objects/backend.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const rawDigest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

export async function createNativeAcceptanceFixture(options={}) {
  const moduleRoot=options.moduleRoot??process.env.SOURCE_CONTROL_MODULE_ROOT;
  const sdkRoot=options.sdkRoot??process.env.SOURCE_CONTROL_SDK_MODULE_ROOT;
  assert(moduleRoot&&sdkRoot,'The native source fixture must compile the real service and SDK');
  const load=name=>import(pathToFileURL(path.join(moduleRoot,name+'.js')));
  const [{createSourceService},{startSourceHttp},{S3SourceObjectBackend},{SOURCE_ACTIONS,SOURCE_API_PATH,canonicalBytes},
    {SourceControlClient},{verifySourcePrincipalToken},{authorizeSource},{sourceDigest},candidateModule]=await Promise.all([
    load('registration'),load('http'),load('s3'),load('contracts'),
    import(pathToFileURL(path.join(sdkRoot,'client.js'))),load('authentication'),load('capabilities'),load('metadata'),load('candidates'),
  ]);
  const actions=options.actions??SOURCE_ACTIONS.filter(action=>!['source.retention.','source.collection.','source.graph.','source.imports.','source.projections.','source.contributions.','source.migration.','source.backups.','source.recovery.','source.routing.'].some(prefix=>action.startsWith(prefix)));
  assert(actions.length>0&&actions.length<=64&&new Set(actions).size===actions.length&&actions.every(action=>SOURCE_ACTIONS.includes(action)),'Fixture requires one through 64 explicit supported capability actions');
  const pool=options.pool??new pg.Pool({connectionString:process.env.DATABASE_URL,max:16});
  const ownsPool=!options.pool;
  const backend=await createSourceS3Fixture();
  const controller=new AbortController();
  const scope=options.scope??{organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
  const sourcePolicy='native-acceptance-fixture-v1';
  const roles=Object.fromEntries(['author','checker'].map(role=>[role,{principal_id:randomUUID(),credential_id:randomUUID(),capability_id:randomUUID()}]));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const trust={issuer:'native-acceptance-fixture',audience:'native-source-acceptance',keys:{'fixture-source-key':publicKey},max_ttl_seconds:300};
  const tokenFor=(role='author',capability)=>{
    const identity=roles[role],now=Math.floor(Date.now()/1000);
    const header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'fixture-source-key',typ:'HF-SOURCE-1'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({schema_version:1,iss:trust.issuer,aud:trust.audience,sub:identity.principal_id,
      credential_id:identity.credential_id,credential_version:'1',principal_kind:identity.kind??'automation',scope,iat:now,nbf:now,exp:now+290,
      capability_id:capability??identity.capability_id})).toString('base64url');
    return header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),privateKey).toString('base64url');
  };
  let server;
  const close=async()=>{if(server)await server.close();controller.abort();await backend.close();if(ownsPool)await pool.end();};
  try {
    if(options.migrate!==false){
      await pool.query('CREATE SCHEMA hyperfide');
      for(const migration of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))
        await pool.query(await fs.readFile(path.join(ROOT,'core/control-plane/migrations',migration),'utf8'));
    }
    await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(scope),sourcePolicy]);
    for(const identity of Object.values(roles)){
      await pool.query(`INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'fixture-source-key',clock_timestamp()+interval '30 minutes')`,[...Object.values(scope),identity.credential_id,identity.principal_id,trust.issuer,trust.audience]);
      await pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY[''],clock_timestamp()+interval '30 minutes')`,[...Object.values(scope),identity.capability_id,identity.principal_id,identity.credential_id,sourcePolicy,[...actions]]);
    }
    const service=createSourceService({pool,backend:new S3SourceObjectBackend(backend.config),cursorKey:randomBytes(32),
      workspaceBudgets:{cache_bytes:16777216,max_cache_entries:1024,max_file_bytes:8388608,materialized_bytes:33554432,dirty_bytes:8388608},...options.serviceOptions});
    await service.metadata.registerRepository(scope,{authority_epoch:'1',policy_version:sourcePolicy,durability_profile:'single-region-verified-s3-v1'});
    server=await startSourceHttp({api:service.api,trust,host:'127.0.0.1',port:0,allowLoopbackHTTP:true,signal:controller.signal});
    const endpoint=server.address+SOURCE_API_PATH;
    const client=new SourceControlClient({endpoint,scope,token:()=>tokenFor('author'),timeout_ms:120000});
    const checkerClient=new SourceControlClient({endpoint,scope,token:()=>tokenFor('checker'),timeout_ms:120000});
    const mutation=(action,input,callOptions={},actor=client)=>{
      const operation=callOptions.operation_id??randomUUID();
      const options={operation_id:operation,idempotency_key:operation,...callOptions};
      const methods={'source.revisions.create':'createRevision','source.domains.create':'createDomain','source.domains.configure':'configureDomain','source.candidates.create':'createCandidate','source.candidates.qualify':'qualifyCandidate','source.acceptance.accept':'acceptCandidate','source.assurance.custody.create':'createSourceCustody','source.assurance.publish':'publishSourceEvidence'};
      if(methods[action])return actor[methods[action]](input,options);
      if(action==='source.assurance.revoke')return input.evidence_id?actor.revokeSourceEvidence(input.evidence_id,options):actor.revokeSourceCustody(input.custody_id,options);
      return actor.call(action,input,options);
    };
    const provenance=message=>({author:{name:'Native acceptance integration',email:'source-acceptance@example.invalid'},message,timestamp:'2026-11-03T00:00:00.000Z'});
    let base;
    const createRevision=async(value={})=>{
      if(typeof value==='string')value={text:value};
      let root=value.root_tree_id;
      if(!root){
        const file=await service.objects.putFile(scope,Buffer.from(value.text??'candidate: valid\n'));
        root=(await service.trees.fromEntries(scope,[{name:'main.txt',kind:'file',mode:'100644',object_id:file.object_id}])).root_tree_id;
      }
      const change_id=value.change_id??randomUUID();
      const receipt=await mutation('source.revisions.create',{change_id,root_tree_id:root,parent_revision_ids:value.parent_revision_ids??(base?[base.revision_id]:[]),predecessor_revision_ids:[],provenance:provenance(value.message??'native acceptance fixture')});
      return {...receipt,change_id};
    };
    const checkPath=options.checkPath??'main.txt';
    const script="const fs=require('node:fs'),crypto=require('node:crypto');const bytes=fs.readFileSync("+JSON.stringify(checkPath)+");const ok=bytes.toString('utf8').startsWith('candidate:');fs.writeFileSync('proof.json',JSON.stringify({sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}));process.stdout.write(ok?'native check passed\\n':'native check failed\\n');process.exitCode=ok?0:7;";
    const environment={LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
    const check={id:'native-main',argv:[process.execPath,'-e',script],executable_digest:rawDigest(await fs.readFile(process.execPath)),environment_digest:sourceDigest(environment),required_artifacts:['proof.json']};
    const policy={policy_id:randomUUID(),policy_digest:sourceDigest({schema_version:1,checks:[check]}),checks:[check]};
    const registerPolicy=async(value=policy)=>{
      await pool.query(`INSERT INTO hyperfide.source_native_assurance_policies(organisation_id,repository_id,security_domain_id,policy_id,policy_digest,authority_epoch,policy_version,checks,expires_at)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,clock_timestamp()+interval '30 minutes')`,[...Object.values(scope),value.policy_id,value.policy_digest,sourcePolicy,JSON.stringify(value.checks)]);
      for(const registered of value.checks)await pool.query(`INSERT INTO hyperfide.source_native_assurance_checkers(organisation_id,repository_id,security_domain_id,policy_id,check_id,principal_id,credential_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '30 minutes')`,[...Object.values(scope),value.policy_id,registered.id,roles.checker.principal_id,roles.checker.credential_id]);
      return value;
    };
    await registerPolicy();
    base=await createRevision({text:'baseline\n',message:'baseline',parent_revision_ids:[]});
    const createDomain=async(revision=base,selectedPolicy=policy)=>mutation('source.domains.create',{domain_id:randomUUID(),revision_id:revision.revision_id,policy_id:selectedPolicy.policy_id,policy_digest:selectedPolicy.policy_digest});
    const domain=await createDomain();
    const custodies=new Map();
    const registerCustody=async revision=>{
      const prior=custodies.get(revision.revision_id);if(prior)return prior;
      const custody_id=randomUUID();
      const result=await mutation('source.assurance.custody.create',{custody_id,custody_generation:'1',revision_id:revision.revision_id});
      const value={...result,custody_id,custody_generation:'1'};custodies.set(revision.revision_id,value);return value;
    };
    const createCandidate=async(revision,config={})=>{
      const selectedDomain=config.domain??domain;
      const custody=await registerCustody(revision);
      const dependencies=config.dependencies??[];
      const input={candidate_id:config.candidate_id??randomUUID(),domain_id:selectedDomain.domain_id,expected_generation:selectedDomain.generation,
        expected_revision_id:selectedDomain.revision_id,revision_id:revision.revision_id,
        contributors:[{revision_id:revision.revision_id,change_id:revision.change_id,custody_id:custody.custody_id,custody_generation:custody.custody_generation}],
        dependencies,inputs:{source:candidateModule.nativeCandidateSourceDigest(scope,revision.revision_id,revision.root_tree_id),dependency:candidateModule.nativeCandidateDependencyDigest(dependencies),
          toolchain:check.executable_digest,configuration:sourceDigest(environment),graph:sourceDigest('fixture-graph-v1'),contract:sourceDigest('fixture-contract-v1')},
        transformation_version:'hyperfide-three-way-v1',...config.input};
      return mutation('source.candidates.create',input,config.options);
    };
    const blob=async(bytes,actor=checkerClient)=>(await mutation('source.objects.put',{kind:'blob',payload_base64:Buffer.from(bytes).toString('base64')},{},actor)).object_id;
    const runCheck=async(candidate,overrides={})=>{
      const working=await fs.mkdtemp(path.join(os.tmpdir(),'hf-native-check-'));
      try{
        const entry=await service.trees.lookup(scope,candidate.root_tree_id,checkPath);assert.equal(entry?.kind,'file');
        await fs.mkdir(path.dirname(path.join(working,checkPath)),{recursive:true});
        await fs.writeFile(path.join(working,checkPath),await service.objects.readFile(scope,entry.object_id));
        const started_at=new Date().toISOString();
        const child=spawn(check.argv[0],check.argv.slice(1),{cwd:working,env:environment,stdio:['ignore','pipe','pipe']});
        const stdout=[],stderr=[];child.stdout.on('data',bytes=>stdout.push(bytes));child.stderr.on('data',bytes=>stderr.push(bytes));
        const observed=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exit_code,signal)=>resolve({exit_code,signal}));});
        const finished_at=new Date().toISOString();
        let absent=false;try{process.kill(child.pid,0);}catch(error){if(error.code==='ESRCH')absent=true;else throw error;}
        assert(absent,'Checker process must be absent before publishing its receipt');
        const stdout_object_id=await blob(Buffer.concat(stdout)),stderr_object_id=await blob(Buffer.concat(stderr));
        const artifact=await blob(await fs.readFile(path.join(working,'proof.json')));
        const receipt={schema_version:1,source_kind:'NATIVE',candidate_id:candidate.candidate_id,candidate_manifest_digest:candidate.manifest_digest,
          revision_id:candidate.revision_id,root_tree_id:candidate.root_tree_id,inputs:candidate.inputs,check_id:check.id,
          command:{argv:check.argv,cwd:'.',executable_digest:check.executable_digest,environment_digest:check.environment_digest,started_at,finished_at,
            exit_code:observed.exit_code,signal:observed.signal,timed_out:false,interrupted:false,output_truncated:false},
          execution:{execution_id:randomUUID(),source_revision_id:candidate.revision_id,source_root_tree_id:candidate.root_tree_id,input_digest:sourceDigest(candidate.inputs),cleanup_complete:true,process_absent:absent},
          output:{stdout_object_id,stderr_object_id},artifacts:[{path:'proof.json',object_id:artifact}]};
        const finalReceipt=overrides.mutate?overrides.mutate(structuredClone(receipt)):receipt;
        return {receipt:finalReceipt,receipt_object_id:await blob(canonicalBytes(finalReceipt)),observed,stdout:Buffer.concat(stdout).toString()};
      }finally{await fs.rm(working,{recursive:true,force:true});}
    };
    const publishEvidence=async(candidate,config={})=>{
      const execution=config.execution??await runCheck(candidate,config);
      const evidence=await mutation('source.assurance.publish',{candidate_id:candidate.candidate_id,check_id:check.id,receipt_object_id:execution.receipt_object_id},config.options,config.actor??checkerClient);
      return {evidence,execution};
    };
    const qualify=async(candidate,config={})=>{
      const published=config.published??await publishEvidence(candidate,config);
      const evidence=published.evidence;
      const qualification=await mutation('source.candidates.qualify',{candidate_id:candidate.candidate_id,evidence_ids:[evidence.evidence_id]},config.qualifyOptions);
      return {qualification,...published};
    };
    const accept=async(candidate,value,callOptions={})=>{
      const qualified=value??await qualify(candidate);
      const qualification=qualified.qualification??qualified;
      return mutation('source.acceptance.accept',{candidate_id:candidate.candidate_id,qualification_id:qualification.qualification_id},callOptions);
    };
    const context=await service.metadata.transaction(tx=>authorizeSource(tx,{principal:verifySourcePrincipalToken(tokenFor(),trust,scope),scope,action:'source.revisions.read',mutation:false}));
    return {ROOT,scope,sourcePolicy,roles,trust,tokenFor,service,pool,backend,endpoint,client,checkerClient,policy,check,environment,base,domain,context,
      sourceDigest,canonicalBytes,createRevision,createDomain,registerPolicy,registerCustody,createCandidate,runCheck,publishEvidence,qualify,accept,mutation,blob,close};
  }catch(error){await close();throw error;}
}
