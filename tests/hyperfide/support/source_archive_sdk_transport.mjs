import fs from 'node:fs';
const endpoint=process.env.HF_SOURCE_ARCHIVE_HTTP_FIXTURE;
if(endpoint){
 const cwd=process.env.HF_SOURCE_ARCHIVE_FIXTURE_CWD;
 if(cwd&&process.argv[1]?.endsWith('/control.js')){if(!cwd.startsWith('/')||fs.realpathSync(cwd)!==cwd||!fs.statSync(cwd).isDirectory())throw Error('Owned trusted fixture CWD required');process.chdir(cwd);}
 const base=new URL(endpoint);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1')throw Error('Archive fixture endpoint must be owned loopback');
 const original=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  const request=input instanceof Request?input:new Request(input,options),url=new URL(request.url);
  if(url.hostname==='api.blaxel.ai'||url.hostname==='run.blaxel.ai'||url.hostname.endsWith('.bl.run')){
   const target=new URL(url.pathname+url.search,base),headers=new Headers(request.headers);headers.set('x-hf-original-origin',url.origin);
   const body=['GET','HEAD'].includes(request.method)?undefined:Buffer.from(await request.arrayBuffer());
   return original(target,{method:request.method,headers,body,signal:request.signal,redirect:'error'});
  }
  if(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))return original(request);
  throw Error('Unconfigured network call forbidden in isolated archive fixture');
 };
}
