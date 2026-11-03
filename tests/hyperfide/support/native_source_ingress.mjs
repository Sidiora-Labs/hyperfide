import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createControlIngressHandler} from '../../../deploy/hyperfide/fleet-control/start.mjs';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hf-native-ingress-'));
let upstream,ingress,ready=true;const received=[],checks=[],bytes=randomBytes(1100000);
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'ca.pem'),'-days','1','-subj','/CN=control.local','-addext','subjectAltName=DNS:control.local'],{stdio:'ignore'});
 const ca=await fs.readFile(path.join(directory,'ca.pem'));
 upstream=https.createServer({cert:ca,key:await fs.readFile(path.join(directory,'key.pem')),minVersion:'TLSv1.3'},async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);received.push({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks)});
  if(req.method==='GET'){res.writeHead(206,{'content-type':'application/octet-stream','content-length':bytes.length,'content-range':'bytes 0-'+(bytes.length-1)+'/'+bytes.length,'accept-ranges':'bytes','x-source-object-id':'sha256:'+'a'.repeat(64)});res.end(bytes);}
  else if(req.method==='PUT'){res.writeHead(204);res.end();}
  else{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}
 });
 await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(9443,'127.0.0.1',resolve);});
 ingress=http.createServer(createControlIngressHandler({ca},()=>ready));await new Promise(resolve=>ingress.listen(0,'127.0.0.1',resolve));
 const request=(method,url,body=Buffer.alloc(0),headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:ingress.address().port,path:url,method,headers:{'content-length':body.length,...headers}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.once('error',reject);req.end(body);});
 const signature={'hf-credential-id':randomUUID(),'hf-request-time':'123','hf-request-nonce':randomUUID(),'hf-request-signature':'signed-proof','content-type':'application/json'};
 for(const url of ['/v1/invoke','/v1/enroll','/api/v1/source-control']){
  const body=Buffer.from(JSON.stringify({value:bytes.toString('base64')}));assert.equal((await request('POST',url,body,signature)).status,200);const actual=received.at(-1);assert.equal(actual.path,url);assert.deepEqual(actual.body,body);for(const [key,value]of Object.entries(signature))assert.equal(actual.headers[key],value);
 }
 checks.push('signed source and existing control routes preserve exact request bytes and proof headers through verified TLS');
 const url='/api/v1/source-control/transfers/'+randomUUID(),authorization='SourceTransfer signed-grant';
 const download=await request('GET',url,undefined,{authorization,range:'bytes=0-1099999'});assert.equal(download.status,206);assert.deepEqual(download.body,bytes);assert.equal(download.headers['content-type'],'application/octet-stream');assert.equal(download.headers['content-range'],'bytes 0-1099999/1100000');assert.equal(download.headers['accept-ranges'],'bytes');assert.equal(received.at(-1).headers.authorization,authorization);assert.equal(received.at(-1).headers.range,'bytes=0-1099999');
 const upload=await request('PUT',url,bytes,{authorization,'content-type':'application/octet-stream','content-range':'bytes 0-1099999/1100000'});assert.equal(upload.status,204);assert.deepEqual(received.at(-1).body,bytes);assert.equal(received.at(-1).headers['content-range'],'bytes 0-1099999/1100000');
 checks.push('binary download and upload preserve bytes, grant, range and response content headers');
 await request('POST','/api/v1/source-control',Buffer.from('{}'),{...signature,authorization:'Bearer mixed'});assert.equal(received.at(-1).headers.authorization,'Bearer mixed');
 checks.push('mixed source authentication reaches the authoritative rejection boundary');
 const before=received.length;for(const [method,target]of [['GET','/api/v1/source-control'],['POST',url],['GET',url+'?extra=1'],['GET','/other']])assert.equal((await request(method,target)).status,404);assert.equal(received.length,before);
 ready=false;assert.equal((await request('POST','/api/v1/source-control')).status,503);assert.equal((await request('GET','/healthz')).status,503);assert.equal(received.length,before);
 checks.push('unsupported routes and methods stay closed and readiness gates every forwarded route');
 const result={status:'PASS',scope:'actual deployment ingress over verified local TLS',checks};await fs.mkdir('build/source-control/native-ingress',{recursive:true});await fs.writeFile('build/source-control/native-ingress/receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{for(const server of [ingress,upstream])if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
