import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {OperationLedger} from './campaign.mjs';

const event=(id,revision,status='ACKNOWLEDGED')=>({operation_id:id,revision_id:revision,status,elapsed_ms:12,checkpoint_rpc_ms:7,queue_delay_ms:2});
const journal=async file=>(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);

test('durable ledger reopens exact measurements without recounting acknowledged revisions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-reopen-'));const file=path.join(root,'events.jsonl');
 try{
  let ledger=new OperationLedger(file);await ledger.record(event('a','r1'));await ledger.record(event('b','r1'));await ledger.record(event('a','r1'));await ledger.record(event('c','r2'));await ledger.record(event('d',null,'REJECTED'));
  const expected=ledger.summary();ledger.close();ledger=new OperationLedger(file);
  assert.deepEqual(ledger.summary(),expected);assert.equal(expected.submitted,5);assert.equal(expected.new_revisions,2);assert.equal(expected.replayed_acknowledgments,1);assert.equal(ledger.hasOperation('a'),true);assert.equal(ledger.hasOperation('d'),false);
  await assert.rejects(ledger.record(event('a','different-revision')),/replay changed revision/);assert.deepEqual(ledger.summary(),expected);
  ledger.close();assert.equal((await journal(file)).length,5);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('committed SQLite event survives process death before its JSONL append',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-crash-'));const file=path.join(root,'events.jsonl');
 try{
  const moduleURL=new URL('./campaign.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {OperationLedger} from ${JSON.stringify(moduleURL)};const ledger=new OperationLedger(${JSON.stringify(file)});ledger.flushJournal=()=>process.kill(process.pid,'SIGKILL');await ledger.record(${JSON.stringify(event('crash','revision'))});`],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL');const ledger=new OperationLedger(file);assert.equal(ledger.hasOperation('crash'),true);assert.equal(ledger.summary().new_revisions,1);ledger.close();assert.deepEqual((await journal(file)).map(x=>x.operation_id),['crash']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('partial append is truncated and a lost JSONL file is rebuilt from authoritative events',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-journal-'));const file=path.join(root,'events.jsonl');
 try{
  let ledger=new OperationLedger(file);await ledger.record(event('a','r1'));await ledger.record(event('b','r2'));const expected=ledger.summary();ledger.close();
  await fs.appendFile(file,'{"partial":');ledger=new OperationLedger(file);assert.deepEqual(ledger.summary(),expected);ledger.close();assert.equal((await journal(file)).length,2);
  await fs.unlink(file);ledger=new OperationLedger(file);assert.deepEqual(ledger.summary(),expected);ledger.close();assert.deepEqual((await journal(file)).map(x=>x.operation_id),['a','b']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('old identifier-only ledgers cannot invent missing measured history',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-legacy-'));const file=path.join(root,'events.jsonl');
 try{const db=new DatabaseSync(file+'.sqlite');db.exec("CREATE TABLE operations(id TEXT PRIMARY KEY); CREATE TABLE revisions(id TEXT PRIMARY KEY); INSERT INTO operations VALUES('old')");db.close();assert.throws(()=>new OperationLedger(file),/no authoritative event history/);}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('daily counters use the persisted campaign anchor across reopen',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-anchor-'));const file=path.join(root,'events.jsonl');const started_at_ms=Date.now()-86400000;
 try{
  let ledger=new OperationLedger(file,{started_at_ms});await ledger.record(event('second-day','r1'));assert.deepEqual(ledger.summary().daily_new_revisions,[0,1,0,0]);ledger.close();
  ledger=new OperationLedger(file,{started_at_ms});assert.deepEqual(ledger.summary().daily_new_revisions,[0,1,0,0]);ledger.close();
  assert.throws(()=>new OperationLedger(file,{started_at_ms:started_at_ms+1}),/campaign anchor/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('ambiguous and interrupted attempts remain visible without becoming false definitive refusals',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-interruption-'));const file=path.join(root,'events.jsonl');
 try{
  let ledger=new OperationLedger(file);await ledger.record(event('a',null,'OUTCOME_UNKNOWN'));await ledger.record(event('a',null,'INTERRUPTED'));await ledger.record(event('a','r1'));
  const expected=ledger.summary();assert.equal(expected.submitted,3);assert.equal(expected.interrupted_attempts,2);assert.equal(expected.rejected,0);assert.equal(expected.new_revisions,1);ledger.close();ledger=new OperationLedger(file);assert.deepEqual(ledger.summary(),expected);ledger.close();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
