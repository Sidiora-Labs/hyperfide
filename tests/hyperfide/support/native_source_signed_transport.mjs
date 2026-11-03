import assert from 'node:assert/strict';
import {createHash,randomUUID,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {createSignedSourceClient} from '../../../core/authority-client/src/index.ts';

const {config,capability_id,wrong_key,tls_key}=JSON.parse(await fs.readFile(process.env.SOURCE_SIGNED_TRANSPORT_INPUT,'utf8'));
const client=await createSignedSourceClient(config),ca=await fs.readFile(config.ca_file),key=await fs.readFile(config.key_file);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const checks=[],hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const passed=message=>{checks.push(message);console.error('signed-source: '+message);};
const endpoint='/api/v1/source-control',origin=new URL(config.endpoint).origin;
const request=(action,input)=>({protocol_version:1,scope:config.scope,operation_id:randomUUID(),action,input});
const proof=(body,{path=endpoint,privateKey=key,nonce=randomUUID(),time=String(Math.floor(Date.now()/1000))}={})=>({
  'content-type':'application/json','HF-Credential-Id':config.credential_id,'HF-Request-Time':time,'HF-Request-Nonce':nonce,
  'HF-Request-Signature':sign(null,Buffer.from(['HYPERFIDE-REQUEST-V1','POST',path,origin,config.credential_id,time,nonce,hash(body),''].join('\n')),privateKey).toString('base64url'),
});
const send=(body,headers,path=endpoint)=>new Promise((resolve,reject)=>{
  const req=https.request(origin+path,{method:'POST',ca,headers,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{try{const bytes=Buffer.concat(chunks);assert(bytes.length,'HTTP '+res.statusCode+' returned no source envelope');resolve({status:res.statusCode,body:JSON.parse(bytes)});}catch(error){reject(error);}});});
  req.once('error',reject);req.end(body);
});
const rejectCode=async(body,headers,code,path=endpoint)=>{const response=await send(body,headers,path);assert.equal(response.body.error?.code,code);assert(response.status>=400);return response;};
try{
  const bytes=Buffer.alloc(1100000,57),input={kind:'blob',payload_base64:bytes.toString('base64')},operation_id=randomUUID();
  const uploaded=await client.call('source.objects.put',input,{operation_id});
  const loaded=await client.object(uploaded.object_id);
  assert.deepEqual(Buffer.from(loaded.payload_base64,'base64'),bytes);
  assert.equal(loaded.byte_length,String(bytes.length));
  assert.equal((await client.call('source.objects.put',input,{operation_id})).object_id,uploaded.object_id);
  passed('signed SDK uploads and reads more than one MiB through production TLS, source authority, PostgreSQL and SigV4 storage');
  const execute=promisify(execFile),directory=path.dirname(process.env.SOURCE_SIGNED_TRANSPORT_INPUT);
  const nativeConfig=path.join(directory,'native-source.json'),nativeRequest=path.join(directory,'native-request.json');
  await fs.writeFile(nativeConfig,JSON.stringify(config),{mode:0o600});
  const nativeCall=async(action,input)=>{
    await fs.writeFile(nativeRequest,JSON.stringify(request(action,input)),{mode:0o600});
    const result=await execute(path.resolve('hyperfide'),['source','invoke','--request-file',nativeRequest],{env:{...process.env,HF_SOURCE_CONFIG:nativeConfig},timeout:30000,maxBuffer:12*1024*1024});
    return JSON.parse(result.stdout).result;
  };
  const nativeBytes=Buffer.alloc(1100001,61);
  const nativePut=await nativeCall('source.objects.put',{kind:'blob',payload_base64:nativeBytes.toString('base64')});
  const nativeRead=await nativeCall('source.objects.read',{object_id:nativePut.object_id});
  assert.deepEqual(Buffer.from(nativeRead.payload_base64,'base64'),nativeBytes);
  passed('native hyperfide source command independently signs and round-trips a file larger than one MiB');
  const body=Buffer.from(JSON.stringify(request('source.capabilities',{}))),headers=proof(body);
  const first=await send(body,headers);assert.equal(first.status,200);assert.equal(first.body.operation_id,JSON.parse(body).operation_id);
  await rejectCode(body,headers,'AUTH_REPLAY');
  await rejectCode(body,proof(body,{path:'/v1/invoke'}),'AUTH_INVALID');
  await rejectCode(body,proof(body,{privateKey:await fs.readFile(wrong_key)}),'AUTH_INVALID');
  await rejectCode(Buffer.from(body.toString().replace('source.capabilities','source.revisions.read')),proof(body),'AUTH_INVALID');
  await rejectCode(body,proof(body,{time:String(Math.floor(Date.now()/1000)-120)}),'AUTH_EXPIRED');
  passed('proof binds source path, exact bytes, actual credential, nonce and request time');
  const duplicate=Object.entries(proof(body)).flat();duplicate.push('Host',new URL(origin).host,'HF-Credential-Id',config.credential_id);
  await rejectCode(body,duplicate,'AUTH_INVALID');
  await rejectCode(body,{...proof(body),authorization:'Bearer ignored'},'AUTH_INVALID');
  passed('duplicate and mixed authentication headers are refused');
  const otherScope={...config.scope,repository_id:randomUUID()};
  const changed=Buffer.from(JSON.stringify({...request('source.capabilities',{}),scope:otherScope}));
  const denied=await send(changed,proof(changed));assert.equal(denied.body.error?.code,'SCOPE_DENIED');assert.equal(denied.status,403);
  passed('signed identity does not grant access to another source scope');
  const oversized=Buffer.from(JSON.stringify(request('source.revisions.read',{revision_id:'sha256:'+'a'.repeat(64),padding:'x'.repeat(1100000)})));
  await rejectCode(oversized,proof(oversized),'LIMIT_EXCEEDED');
  const legacy=await send(oversized,proof(oversized,{path:'/v1/invoke'}),'/v1/invoke');
  assert.equal(legacy.status,413);assert.equal(legacy.body.error?.code,'REQUEST_TOO_LARGE');
  passed('large-object allowance does not widen metadata or ordinary control request limits');
  await pool.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[capability_id]);
  await assert.rejects(()=>client.object(uploaded.object_id),error=>error.code==='SCOPE_DENIED');
  passed('source capability revocation takes effect on the next signed request');
  await pool.query("UPDATE hyperfide.identity_principals SET state='REVOKED' WHERE credential_id=$1",[config.credential_id]);
  const revoked=await send(body,proof(body));assert(revoked.status>=400);assert.match(revoked.body.error?.code??'',/^AUTH_/);
  passed('native credential revocation independently fences signed source requests');
  let fault='malformed';
  const broken=https.createServer({cert:ca,key:await fs.readFile(tls_key)},async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const operation=JSON.parse(Buffer.concat(chunks)).operation_id;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(fault==='malformed'?'{' : JSON.stringify(fault==='malformed-error'?{protocol_version:1,operation_id:operation,error:{code:'UNKNOWN'}}:{protocol_version:1,operation_id:randomUUID(),result:{}}));
  });
  await new Promise(resolve=>broken.listen(0,'127.0.0.1',resolve));
  try{
    await fs.writeFile(nativeConfig,JSON.stringify({...config,endpoint:'https://127.0.0.1:'+broken.address().port+endpoint}));
    for(fault of ['malformed','mismatched-operation','malformed-error']){
      const original=request('source.objects.put',{kind:'blob',payload_base64:'eA=='});
      await fs.writeFile(nativeRequest,JSON.stringify(original));
      const faultClient=await createSignedSourceClient({...config,endpoint:'https://127.0.0.1:'+broken.address().port+endpoint});
      await assert.rejects(()=>faultClient.call(original.action,original.input,{operation_id:original.operation_id}),error=>error.code==='OUTCOME_UNKNOWN'&&error.outcome==='UNKNOWN'&&error.retry==='RETRY_SAME_OPERATION'&&error.details?.operation_id===original.operation_id);
      await assert.rejects(()=>execute(path.resolve('hyperfide'),['source','invoke','--request-file',nativeRequest],{env:{...process.env,HF_SOURCE_CONFIG:nativeConfig},timeout:30000}),error=>{
        assert.equal(error.code,75);
        const envelope=JSON.parse(error.stderr);
        assert.equal(envelope.operation_id,original.operation_id);
        assert.equal(envelope.error.code,'OUTCOME_UNKNOWN');
        assert.equal(envelope.error.retry,'RETRY_SAME_OPERATION');
        assert.equal(envelope.error.outcome,'UNKNOWN');
        return true;
      });
    }
  }finally{await new Promise(resolve=>broken.close(resolve));}
  passed('SDK and native CLI retain original mutation identity and unknown outcome after malformed or mismatched TLS responses');
  const receipt={status:'PASS',checks,scope:'actual production source route, signed SDK, identity and source capability authority, owned PostgreSQL and SigV4 byte store'};
  await fs.mkdir('build/source-control/signed-transport',{recursive:true});
  await fs.writeFile('build/source-control/signed-transport/receipt.json',JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
}finally{await pool.end();}
