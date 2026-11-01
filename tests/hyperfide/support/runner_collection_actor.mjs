import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import readline from 'node:readline';
const [dist,components,policyFile]=process.argv.slice(2),controller=new AbortController();
const {ComponentRegistry}=await import(pathToFileURL(dist+'/components/registry.js'));
const {validatePolicy}=await import(pathToFileURL(dist+'/policy/programme.js'));
const raw=JSON.parse(fs.readFileSync(policyFile,'utf8'));
const registry=new ComponentRegistry({role:'provisioner',policy:validatePolicy(raw,raw.spec_revision,'provisioner'),signal:controller.signal,env:process.env});
try{
 await registry.load(components,dist);
 const identity=registry.resolveCapability('14.1','identity.authority',v=>v&&typeof v.authenticate==='function');
 registry.installInvocationAuthorizer(i=>identity.authorize(i));
 const provider=registry.resolveCapability('8.3','provider.execution.v1',v=>v&&typeof v.reconcileBound==='function');
 process.stdout.write(JSON.stringify({ready:true})+'\n');
 for await(const line of readline.createInterface({input:process.stdin})){
  let q;
  try{
   q=JSON.parse(line);
   const i=await identity.authenticate(Buffer.from(q.body,'base64'),q.headers,controller.signal);
   await identity.authorize(i);
   const result=await provider.reconcileBound(q.input,controller.signal,i,q.lease_id);
   process.stdout.write(JSON.stringify({id:q.id,ok:true,result})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({id:q?.id,ok:false,error:{code:error.code??error.name,message:error.message}})+'\n');}
 }
}finally{controller.abort();await registry.close();}
