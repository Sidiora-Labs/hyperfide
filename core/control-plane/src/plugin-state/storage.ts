import { exact, fail } from '../transport/protocol.js';
import type { AuthorityTransaction, InvocationContext } from '../transport/protocol.js';

export async function pluginState(tx: AuthorityTransaction, i: InvocationContext, v: unknown): Promise<unknown> {
 if (!v || typeof v !== 'object') fail('INVALID_REQUEST','Object required');
 const fields = Object.keys(v);
 exact(v, ['plugin','scope','operation', ...['entries','remove','key','after'].filter(k=>fields.includes(k))]);
 if (!['hyperfide-spec','hyperfide-asks','hyperfide-qualify','hyperfide-dispatch'].includes(String(v.plugin)) ||
   typeof v.scope !== 'string' || !v.scope.length || v.scope.length > 2048 || !['list','get','write','import','scopes'].includes(String(v.operation))) fail('INVALID_REQUEST','Invalid plugin scope or operation');
 const scope = [i.principal.organisation_id, i.principal.run_id, v.plugin, v.scope];
 if (v.operation === 'scopes') {
  exact(v,['plugin','scope','operation']);
  return (await tx.query('SELECT DISTINCT scope AS key, NULL AS value FROM hyperfide.plugin_state WHERE organisation_id=$1 AND run_id=$2 AND plugin=$3 ORDER BY scope',scope.slice(0,3))).rows;
 }
 if (v.operation === 'get') {
  exact(v,['plugin','scope','operation','key']);
  if (typeof v.key!=='string'||!v.key.length||v.key.length>2048) fail('INVALID_REQUEST','Invalid key');
  return (await tx.query('SELECT key,value FROM hyperfide.plugin_state WHERE organisation_id=$1 AND run_id=$2 AND plugin=$3 AND scope=$4 AND key=$5',[...scope,v.key])).rows;
 }
 if (v.operation === 'list') {
  exact(v,v.after===undefined?['plugin','scope','operation']:['plugin','scope','operation','after']);
  if (v.after!==undefined&&(typeof v.after!=='string'||v.after.length>2048)) fail('INVALID_REQUEST','Invalid cursor');
  const rows = (await tx.query('SELECT key,value FROM hyperfide.plugin_state WHERE organisation_id=$1 AND run_id=$2 AND plugin=$3 AND scope=$4 AND key COLLATE "C">$5 ORDER BY key COLLATE "C" LIMIT 128',[...scope,v.after??''])).rows;
  let size=0;
  const page=[];
  for(const row of rows){const bytes=Buffer.byteLength(JSON.stringify(row));if(page.length&&size+bytes>512*1024)break;page.push(row);size+=bytes;}
  return page;
 }
 exact(v,['plugin','scope','operation','entries','remove']);
 const entries = v.entries, remove = v.remove ?? [];
 if (!Array.isArray(entries) || entries.length>128 || !Array.isArray(remove) || remove.length>128 || (v.operation==='import' && remove.length)) fail('INVALID_REQUEST','Invalid plugin state batch');
 const key = (k: unknown): k is string => typeof k==='string' && k.length>0 && k.length<=2048;
 const seen = new Set<string>();
 for (const e of entries) {
  exact(e,['key','value']);
  if (!key(e.key) || seen.has(e.key) || Buffer.byteLength(JSON.stringify(e.value))>256*1024) fail('INVALID_REQUEST','Invalid plugin entry');
  seen.add(e.key);
 }
 if (!remove.every(key) || remove.some(k=>seen.has(k))) fail('INVALID_REQUEST','Invalid removed keys');
 // Serialize imports and ordinary writes for a scope, including initially absent rows.
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(scope)]);
 for (const e of entries) {
  if (v.operation==='import') {
   const old=(await tx.query('SELECT value=$5::jsonb AS equal FROM hyperfide.plugin_state WHERE organisation_id=$1 AND run_id=$2 AND plugin=$3 AND scope=$4 AND key=$6',[...scope,JSON.stringify(e.value),e.key])).rows[0];
   if (old && !old.equal) fail('PLUGIN_MIGRATION_CONFLICT','Existing plugin state differs');
  }
  await tx.query('INSERT INTO hyperfide.plugin_state(organisation_id,run_id,plugin,scope,key,value) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(organisation_id,run_id,plugin,scope,key) DO UPDATE SET value=excluded.value',[...scope,e.key,JSON.stringify(e.value)]);
 }
 for (const k of remove) await tx.query('DELETE FROM hyperfide.plugin_state WHERE organisation_id=$1 AND run_id=$2 AND plugin=$3 AND scope=$4 AND key=$5',[...scope,k]);
 await i.guard(tx);
 return [];
}
