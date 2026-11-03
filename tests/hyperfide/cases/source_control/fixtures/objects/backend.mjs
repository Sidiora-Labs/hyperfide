import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,createHmac} from 'node:crypto';
export async function createSourceS3Fixture(){
 const backendObjects=new Map(),requests=[],faults={losePut:false,loseDelete:false,delayDelete:false,unavailableReads:0,corrupt:false},pendingDeletes=[];
const hmac=(key,text)=>createHmac('sha256',key).update(text).digest();
const backend=http.createServer(async(req,res)=>{
 try{
 const bytes=Buffer.concat(await Array.fromAsync(req)),url=new URL(req.url,'http://127.0.0.1'),payload=createHash('sha256').update(bytes).digest('hex');
 const auth=/Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)/.exec(req.headers.authorization??'');assert(auth&&auth[1]==='fixture-access');assert.equal(req.headers['x-amz-content-sha256'],payload);
 const names=auth[3].split(';'),headers=names.map(name=>name+':'+String(req.headers[name]).trim()+'\n').join(''),canonical=[req.method,url.pathname,url.searchParams.toString(),headers,names.join(';'),payload].join('\n');
 const [day,region,service,last]=auth[2].split('/');assert.equal(region,'fixture-region');assert.equal(service,'s3');assert.equal(last,'aws4_request');
 const signing=hmac(hmac(hmac(hmac('AWS4fixture-secret',day),region),service),last),toSign='AWS4-HMAC-SHA256\n'+req.headers['x-amz-date']+'\n'+auth[2]+'\n'+createHash('sha256').update(canonical).digest('hex');assert.equal(hmac(signing,toSign).toString('hex'),auth[4]);
 requests.push({method:req.method,key:url.pathname,bytes:bytes.length});
 if(req.method==='PUT'){assert.equal(req.headers['if-none-match'],'*');if(backendObjects.has(url.pathname)){res.writeHead(412).end();return;}backendObjects.set(url.pathname,bytes);if(faults.losePut){faults.losePut=false;req.socket.destroy();return;}res.writeHead(200).end();return;}
 if(req.method==='GET'){if(faults.unavailableReads){faults.unavailableReads--;res.writeHead(503).end();return;}const stored=backendObjects.get(url.pathname);if(!stored){res.writeHead(404).end();return;}const body=faults.corrupt?Buffer.concat([stored.subarray(0,-1),Buffer.from([stored.at(-1)^1])]):stored;res.writeHead(200,{'content-length':body.length,etag:'"owned-fixture"'}).end(body);return;}
 if(req.method==='DELETE'){assert.equal(req.headers['if-match'],'"owned-fixture"');if(faults.delayDelete){faults.delayDelete=false;await new Promise(resolve=>pendingDeletes.push(resolve));}backendObjects.delete(url.pathname);if(faults.loseDelete){faults.loseDelete=false;req.socket.destroy();return;}res.writeHead(204).end();return;}
 res.writeHead(405).end();
 }catch(error){res.writeHead(500).end(String(error));}
});

 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 return {backendObjects,requests,faults,pendingDeletes,resumeDeletes:()=>pendingDeletes.splice(0).forEach(resolve=>resolve()),config:{endpoint:'http://127.0.0.1:'+backend.address().port,region:'fixture-region',bucket:'fixture-bucket',accessKey:'fixture-access',secretKey:'fixture-secret',allowLoopbackHTTP:true},close:()=>new Promise(resolve=>backend.close(resolve))};
}
