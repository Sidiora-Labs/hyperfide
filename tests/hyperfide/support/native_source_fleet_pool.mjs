import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function createNativeFleetPool({f,ids,revision,capacity,resources,controlRoot}) {
  const prior=(await f.pool.query(`SELECT p.*,e.runtime_platform,e.manifest FROM hyperfide.provider_pools p
    JOIN hyperfide.environment_profiles e ON e.organisation_id=p.organisation_id AND e.id=p.profile_id
    WHERE p.organisation_id=$1 AND p.id=$2`,[ids.organisation,ids.pool])).rows[0];
  assert(prior,'A declared provider profile is required');
  const profile=randomUUID(),pool=randomUUID(),sandbox=randomUUID();
  const body=structuredClone(prior.manifest);
  delete body.digest;
  body.profile.profile_id=profile;
  body.profile.repositories=[{id:ids.repository,url:'https://source.example.invalid/native',commit:revision.revision_id,
    source_backend:'native',security_domain_id:f.scope.security_domain_id,submodules:[],lfs:false}];
  const preparation=f.sourceDigest(body),manifest={...body,digest:preparation};
  const insert=async(table,row)=>{const keys=Object.keys(row);await f.pool.query('INSERT INTO hyperfide.'+table+'('+keys.join(',')+') VALUES('+keys.map((_,n)=>'$'+(n+1)).join(',')+')',Object.values(row));};
  await insert('environment_profiles',{organisation_id:ids.organisation,id:profile,content_digest:preparation,provider:prior.provider,runtime_platform:prior.runtime_platform,manifest});
  await insert('provider_pools',{organisation_id:ids.organisation,id:pool,provider:prior.provider,account_key:prior.account_key,environment_key:'native-'+pool,region:prior.region,profile_id:profile});
  await insert('scheduling_policies',{organisation_id:ids.organisation,pool_id:pool});
  const accounts=(await f.pool.query('SELECT * FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2',[ids.organisation,ids.pool])).rows;
  const mapped=new Map();
  for(const account of accounts){
    const id=randomUUID();mapped.set(account.id,id);
    await insert('capacity_accounts',{organisation_id:ids.organisation,id,pool_id:pool,dimension:account.dimension,capacity_class:account.capacity_class,
      configured_limit:account.configured_limit,provenance_digest:account.provenance_digest,qualification_state:account.qualification_state});
  }
  await insert('sandboxes',{organisation_id:ids.organisation,id:sandbox,pool_id:pool,native_sandbox_id:'native-fixture-'+sandbox,observed_state:'RUNNING',preparation_digest:preparation});
  const boot=(await f.pool.query('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2 AND boot_generation=1',[ids.organisation,sandbox])).rows[0].boot_id;
  const oldBudget=(await f.pool.query('SELECT * FROM hyperfide.sandbox_execution_budgets WHERE organisation_id=$1 AND sandbox_id=$2 AND sandbox_boot_generation=1',[ids.organisation,ids.sandbox])).rows[0];
  assert(oldBudget,'The fixture must declare its fixed sandbox budget');
  const {qualifySandboxBudget}=await import(pathToFileURL(path.join(controlRoot,'scheduler/claim.js')));
  await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>qualifySandboxBudget(tx,{
    organisation_id:ids.organisation,sandbox_id:sandbox,sandbox_boot_generation:'1',qualification_id:randomUUID(),
    evidence_digest:f.sourceDigest({kind:'DECLARED_NATIVE_FIXTURE_BUDGET',sandbox,source:oldBudget.qualification_id}),source:'OPERATOR_FIXED',
    hard_limits:{cpu_millis:String(oldBudget.hard_cpu_millis),memory_bytes:String(oldBudget.hard_memory_bytes),disk_bytes:String(oldBudget.hard_disk_bytes)},
    headroom:{cpu_millis:String(oldBudget.headroom_cpu_millis),memory_bytes:String(oldBudget.headroom_memory_bytes),disk_bytes:String(oldBudget.headroom_disk_bytes)},
  }));
  const nextCapacity=capacity.map(row=>{assert(mapped.has(row.capacity_account_id));return {...row,capacity_account_id:mapped.get(row.capacity_account_id)};}).sort((a,b)=>a.capacity_account_id.localeCompare(b.capacity_account_id));
  return {ids:{...ids,pool,sandbox,boot},capacity:nextCapacity,profile};
}
