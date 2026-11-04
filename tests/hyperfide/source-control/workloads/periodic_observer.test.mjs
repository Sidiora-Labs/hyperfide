import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PeriodicObserver,observationCoverage} from './periodic_observer.mjs';
test('periodic and explicit observations serialize and stopping waits for the active observation',async()=>{
 let release,started,active=0,maximum=0,calls=0;
 const running=new Promise(resolve=>{started=resolve;});
 const held=new Promise(resolve=>{release=resolve;});
 const observer=new PeriodicObserver(async phase=>{active++;maximum=Math.max(maximum,active);calls++;if(calls===1){started();await held;}await delay(5);active--;return phase;},error=>{throw error;});
 observer.start(1);await running;const explicit=observer.sample('boundary');let stopped=false;const stopping=observer.stop().then(()=>{stopped=true;});await delay(10);assert.equal(stopped,false);release();assert.equal(await explicit,'boundary');await stopping;assert.equal(maximum,1);const finalCalls=calls;await delay(10);assert.equal(calls,finalCalls);assert.equal(calls,2);
});
test('failed observation preserves evidence, reports once, and fails shutdown without an unhandled timer rejection',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-observer-lifecycle-'));let failures=0,notify;
 const failed=new Promise(resolve=>{notify=resolve;});const error=new Error('owned observer failure');
 const observer=new PeriodicObserver(async()=>{await fs.writeFile(path.join(directory,'failed-hook.json'),JSON.stringify({status:'FAIL',observed:true}));throw error;},value=>{assert.equal(value,error);failures++;notify();});
 try{observer.start(1);await failed;await assert.rejects(()=>observer.sample('boundary'),value=>value===error);await assert.rejects(()=>observer.stop(),value=>value===error);assert.equal(failures,1);assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'failed-hook.json'),'utf8')),{status:'FAIL',observed:true});await delay(10);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('coverage checks include both window edges and reject a single sample across a long workload',()=>{
 assert.throws(()=>observationCoverage(0,259200000,[129600000],661000),/coverage gap/);
 assert.throws(()=>observationCoverage(0,1000,[900],200),/coverage gap/);
 assert.throws(()=>observationCoverage(0,1000,[100],200),/coverage gap/);
 assert.throws(()=>observationCoverage(0,1000,[-10,1010],200),/No periodic/);
 assert.deepEqual(observationCoverage(0,1000,[800,200,600,400],200),{samples:4,maximum_gap_ms:200,allowed_gap_ms:200});
});
