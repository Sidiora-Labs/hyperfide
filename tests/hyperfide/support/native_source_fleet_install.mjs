import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const execute=promisify(execFile);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const kvx=value=>Object.entries(value).map(([section,body])=>'['+section+']\n'+Object.entries(body).map(([key,item])=>key+' = '+JSON.stringify(item)).join('\n')).join('\n\n')+'\n';

export async function installNativeFleetFixture(fixture,{root,controlRoot,revision,fleet}) {
  assert.equal(process.getuid(),0,'Native preparation needs protected root-owned staging');
  const contracts=await import(pathToFileURL(path.join(controlRoot,'contracts/fleet/index.mjs')));
  const {canonical,digest,INSTALL_STAGES,parseNeron,parsePackage,createInterfaceIndex,selectInterfaces}=contracts;
  const source=await fixture.client.nativeFleetManifest({revision_id:revision.revision_id,paths:['main.txt'],max_files:8,max_bytes:4194304,max_nodes:128,metadata_only:false});
  const environment=path.join(root,'environment'),operation=randomUUID(),environmentId='native-fleet-'+randomUUID();
  const nodeDigest=hash(await fs.readFile(process.execPath));
  const neron={meta:{format:'neron.source-config',schema_version:1},source:{endpoint:'https://localhost/api/v1/source-control',repository:fixture.scope.repository_id,source_backend:'native',revision:revision.revision_id,auth_profile:'profile-ref:native-fleet'},
    workspace:{workspace_id:randomUUID(),workspace_generation:1,environment_id:environmentId,environment_generation:1,authority_epoch:fleet?.epoch??randomUUID(),read_scope:['main.txt'],write_scope:['main.txt']},
    cache:{directory:environment+'/cache',max_bytes:8388608,max_entries:16,security_domain:fixture.scope.security_domain_id},
    client:{mode:'sparse',dirty_directory:environment+'/dirty',network_policy:'online-required'}};
  const catalogue='[interface.main]\nkind = "file"\npath = "main.txt"\nline = 1\nsignature = "candidate text"\ncallers = []\nstatus = "authored"\ncontract = "The worker updates the selected candidate text."\nnotes = "Native source fixture input."\n';
  const selectedIds=['interface.main'];
  const packageValue={meta:{format:'hyperfide.sandbox-package',schema_version:1,name:'native-fleet-fixture',version:'1.0.0'},
    environment:{environment_id:environmentId,environment_generation:1,platform:process.platform+'-'+(process.arch==='x64'?'amd64':process.arch),image_digest:digest('declared local native preparation'),root:environment},
    bootstrap:{installer_path:process.execPath,installer_version:process.version,installer_sha256:nodeDigest,delivery:'image'},
    source:{config:'.neron',config_digest:digest(parseNeron(kvx(neron))),adapter_contract:'source-manifest-v1'},
    'mount.code':{kind:'source',source:'primary',paths:['main.txt'],target:environment+'/base',access:'read_only',mode:'sparse'},
    'toolchain.node':{kind:'node',version:process.version.slice(1),delivery:'image',artifact_digest:nodeDigest,executable:process.execPath},
    interfaces:{catalogue:'interfaces.kvx',catalogue_digest:digest(catalogue),source_revision:revision.revision_id,selected_ids:selectedIds,output:environment+'/context/interfaces.kvx',max_blocks:8,max_bytes:65536},
    install:{scope:'environment_generation',stages:INSTALL_STAGES,reuse_policy:'exact-input-clean',dirty_policy:'refuse-overwrite'},
    workers:{slots:2,source_template:environment+'/workers/{slot}/source',home_template:environment+'/workers/{slot}/home',build_template:environment+'/workers/{slot}/build',temporary_template:environment+'/workers/{slot}/tmp',dirty_template:environment+'/workers/{slot}/dirty',isolation:'private-overlay'},
    readiness:{require_stages:INSTALL_STAGES.slice(0,-1),require_probes:[],receipt:environment+'/state/install.json'}};
  const packageText=kvx(packageValue),sourceText=kvx(neron),parsed=parsePackage(packageText,{neron:parseNeron(sourceText)});
  const index=createInterfaceIndex({catalogue,sourceRevision:revision.revision_id,provenance:{kind:'authored',source_revision:revision.revision_id,producer:'native-fleet-fixture',version:'1',input_digest:digest(catalogue)}});
  const selected=await selectInterfaces(index,{ids:selectedIds,sourceRevision:revision.revision_id,catalogueDigest:digest(catalogue),maxBlocks:8,maxBytes:65536});
  const consumerId='environment.'+environmentId;
  const proof={schema_version:1,kind:'hyperfide.fleet-interface-proof',publication:index.publication,entries:selected.entries,
    consumer:{kind:'hyperfide.fleet-interface-consumer',consumer_id:consumerId,package_digest:digest(parsed),source_revision:revision.revision_id,selected_ids:selectedIds}};
  const runtimeFiles=[];
  const visit=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const filename=path.join(directory,entry.name);if(entry.isDirectory())await visit(filename);else if(entry.isFile()&&/\.(?:js|mjs)$/.test(entry.name))runtimeFiles.push({path:filename,digest:hash(await fs.readFile(filename))});}};
  await visit(controlRoot);
  const plan={schema_version:1,kind:'hyperfide.fleet-install-plan',package_digest:digest(parsed),source_config_digest:digest(parseNeron(sourceText)),source_manifest_digest:source.digest,
    runtime_files:runtimeFiles,configuration_versions:[],interface_fragment_digest:digest(catalogue),interface_publication_digest:digest(index.publication),interface_proof_digest:digest(proof),interface_consumer_id:consumerId,
    source_files:source.entries.map(entry=>({mount:'code',path:entry.path,digest:entry.digest,size:entry.size,mode:entry.mode}))};
  const slots=[0,1].map(slot=>({slot,worker_slot_id:randomUUID(),slot_generation:'1',uid:62541+slot,gid:62541+slot,worker_root:environment+'/workers/'+slot,
    ...Object.fromEntries(['source','home','build','temporary','dirty'].map(field=>[field,parsed.workers[field+'_template'].replace('{slot}',String(slot))]))}));
  const admission={schema_version:1,kind:'hyperfide.fleet-install-admission',operation_id:operation,logical_operation_id:operation,organisation_id:fixture.scope.organisation_id,run_id:fleet?.run??randomUUID(),environment_id:environmentId,environment_generation:1,environment_root:environment,sandbox_id:fleet?.sandbox??randomUUID(),boot_id:fleet?.boot??randomUUID(),boot_generation:'1',authority_epoch:neron.workspace.authority_epoch,input_digest:digest({plan:plan.package_digest,source:source.digest}),package_digest:plan.package_digest,source_config_digest:plan.source_config_digest,plan_digest:digest(plan),source_revision:revision.revision_id,source_manifest_digest:source.digest,read_scope:['main.txt'],write_scope:['main.txt'],slot_bindings:slots,expires_at:new Date(Date.now()+300000).toISOString()};
  admission.admission_digest=digest(admission);
  const stage=path.join('/run/hyperfide-stage',operation);
  await fs.mkdir('/run/hyperfide-stage',{recursive:true,mode:0o755});
  await fs.mkdir(stage,{mode:0o750});
  const staged={'input-manifest':{schema_version:1,kind:'hyperfide.fleet-install-bootstrap',admission,plan_digest:digest(plan)},'fleet.plan':plan,'fleet.package':packageText,'fleet.source-config':sourceText,'fleet.source-manifest':source,'fleet.interfaces':catalogue,'fleet.interface-proof':proof};
  const refs=[];
  for(const [role,value]of Object.entries(staged)){const filename=path.join(stage,'input-'+refs.length);await fs.writeFile(filename,typeof value==='string'?value:canonical(value),{mode:0o440});refs.push({role,path:filename});}
  const context={schema_version:1,operation_id:operation,job_binding:{namespace:'FLEET_INSTALL',job_id:operation,lease_generation:'1',input_packet_digest:admission.admission_digest},scope:{sandbox_id:admission.sandbox_id,boot_id:admission.boot_id,boot_generation:'1'},staging:refs,out_root:stage+'/out'};
  const contextFile=stage+'/context.json';await fs.writeFile(contextFile,canonical(context),{mode:0o440});
  try{
    const command=await execute(process.execPath,[path.join(controlRoot,'preparation/fleet_install.js'),'--job-context',contextFile],{timeout:120000,maxBuffer:4*1024*1024});
    const prepared=JSON.parse(command.stdout);
    assert.equal(prepared.state,'PREPARED');
    assert.equal(prepared.receipt.source_revision,revision.revision_id);
    assert.equal(prepared.receipt.source_manifest_digest,source.digest);
    assert.deepEqual(prepared.receipt.source_files.map(entry=>entry.path),['main.txt']);
    assert.equal(prepared.receipt.slots.length,2);
    assert.deepEqual(prepared.receipt.probes,[]);
    const first=prepared.receipt.slots[0].source,second=prepared.receipt.slots[1].source;
    assert.notEqual((await fs.stat(first+'/main.txt')).ino,(await fs.stat(second+'/main.txt')).ino);
    assert.equal((await fs.readFile(first+'/.neron','utf8')).includes('source_backend = "native"'),true);
    await assert.rejects(fs.stat(first+'/private.txt'),error=>error.code==='ENOENT');
    return {source,prepared,first,second,packageValue,neron,admission,plan,stage};
  }catch(error){await fs.rm(stage,{recursive:true,force:true});throw error;}
}
