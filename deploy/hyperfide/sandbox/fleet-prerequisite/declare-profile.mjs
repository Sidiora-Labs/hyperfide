import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const options=new Map();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--source-inputs','--seed-context','--prepared-receipt','--output','--authority-origin'].includes(key)||!value||options.has(key))throw new Error('Explicit source inputs, seed context, prepared runtime receipt, output and authority origin are required');options.set(key,value);}
for(const name of ['--source-inputs','--seed-context','--prepared-receipt','--output','--authority-origin'])if(!options.has(name))throw new Error('Missing '+name);
const output=path.resolve(options.get('--output')),privateRoot=path.join(root,'build/fleet/integration/private');
if(!output.startsWith(privateRoot+path.sep))throw new Error('Declared profile output must remain in the private integration directory');
const context=path.resolve(options.get('--seed-context'));
const prepared=JSON.parse(await fs.readFile(options.get('--prepared-receipt'),'utf8'));
const seedBytes=await fs.readFile(path.join(context,'payload/opt/hyperfide/seed-manifest.json')),seed=JSON.parse(seedBytes.toString('utf8'));
const source=JSON.parse(await fs.readFile(options.get('--source-inputs'),'utf8'));
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
if(prepared.status!=='PREPARED'||prepared.context!==context||prepared.manifest_digest!==hash(seedBytes.subarray(0,seedBytes.length-1))||seed.runtime.node!=='24.22.0'||seed.runtime.npm!=='11.19.1'||seed.runtime.claude!=='2.1.300'||seed.runtime.python!=='3.14.8')throw new Error('A fully inventoried worker runtime input bundle is required');
if(!/^docker\.io\/library\/ubuntu@sha256:[a-f0-9]{64}$/.test(seed.base_images.ubuntu.reference)||seed.base_images.ubuntu.reference.split('@')[1]!==seed.base_images.ubuntu.platform_digest)throw new Error('Actual full OCI base image identity required');
const {validateProfile,createManifest,verifyManifest}=await import(pathToFileURL(path.join(root,'core/control-plane/dist/preparation/manifests.js')).href);
await fs.mkdir(output,{mode:0o700});
const candidate=path.join(output,'candidate');await fs.mkdir(candidate,{mode:0o755});
const sourceRoot=await fs.realpath(source.source_root),lockPath=await fs.realpath(source.package_lock_path);
if(!lockPath.startsWith(sourceRoot+path.sep)||path.basename(lockPath)!=='package-lock.json'||!(await fs.lstat(lockPath)).isFile())throw new Error('Actual source lockfile must stay inside the accepted source root');
await fs.copyFile(lockPath,path.join(candidate,'package-lock.json'));
await fs.copyFile(path.join(context,'payload/opt/hyperfide/services/dist/preparation/fleet_install.js'),path.join(candidate,'fleet_install.js'));
await fs.copyFile(path.join(context,'Dockerfile'),path.join(candidate,'Dockerfile'));
await fs.writeFile(path.join(candidate,'runtime-input-evidence.json'),JSON.stringify({schema_version:1,kind:'hyperfide.seed-runtime-inputs',manifest_digest:prepared.manifest_digest,control_source_digest:seed.control_source_digest,runtime:seed.runtime,files:seed.files.length,base_images:seed.base_images},null,2)+'\n',{mode:0o644});
await fs.writeFile(path.join(candidate,'seed-manifest.json'),seedBytes,{mode:0o644});
const pin=async name=>({path:name,digest:hash(await fs.readFile(path.join(candidate,name)))});
const route=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Credential-free HTTPS network route required');return url.hostname+':'+(url.port||'443');};
const routes=[route(options.get('--authority-origin'))];
for(const name of ['MESSAGES_URL','HF_ARTIFACT_S3_ENDPOINT'])if(process.env[name])routes.push(route(process.env[name]));
const gitVersion=/git version (\d+\.\d+\.\d+)/.exec(seed.runtime.git)?.[1];if(!gitVersion)throw new Error('Observed Git version required');
const profile=validateProfile({schema_version:1,profile_id:source.profile_id,profile_version:'1.0.0',
 os:{distribution:'ubuntu',version:'24.04',architecture:'x86_64'},
 image:{provider:'blaxel',reference:seed.base_images.ubuntu.reference,digest:seed.base_images.ubuntu.platform_digest},
 resources:{cpu_millis:2000,memory_bytes:'4294967296',disk_bytes:'1073741824',persistent_volume_bytes:'0'},
 toolchains:[{name:'node',version:'24.22.0'},{name:'python3',version:'3.14.8'},{name:'git',version:gitVersion}],
 package_managers:[{name:'npm',version:'11.19.1',locks:[await pin('package-lock.json')]}],
 native_agents:[{name:'claude',version:'2.1.300'}],connectors:[{name:'hyperfide-claude-stdio',version:'2.1.300'}],
 supervisor:{name:'python3',version:'3.14.8'},hyperfide:{version:seed.runtime.hyperfide},system_packages:[],
 repositories:[{id:source.source_repository_key,url:source.repository_url,commit:source.commit,submodules:[],lfs:false}],
 recipe:await pin('fleet_install.js'),generated_inputs:[await pin('seed-manifest.json')],build_config:[await pin('Dockerfile')],caches:[],
 required_capabilities:['execute','transfer','stdin'],network:{routes:[...new Set(routes)],registries:['registry.npmjs.org']},credential_references:['secret-ref:fleet-worker-gateway'],
 policy:{max_process_lifetime_seconds:1200,expires_at:new Date(Date.now()+86400000).toISOString(),rebuild_on:['source','locks','toolchains','runtime']},preparation_evidence:[await pin('runtime-input-evidence.json')]});
const secretCanaries=[...new Set(Object.entries(process.env).filter(([name,value])=>/(KEY|TOKEN|SECRET|PASSWORD)/.test(name)&&typeof value==='string'&&value.length>=8&&value.length<=4096).map(([,value])=>value))].slice(0,64);
const scan_policy={secret_canaries:secretCanaries,identity_canaries:[],lease_canaries:[]};
const env={...process.env,HF_PREPARATION_ALLOWED_ROOT:output};
const manifest=await createManifest({candidate_path:'candidate',profile,scan_policy},{env,signal:new AbortController().signal});
await verifyManifest({candidate_path:'candidate',manifest,scan_policy},{env,signal:new AbortController().signal});
const declaration={profile_id:source.profile_id,runtime_platform:'linux-amd64',manifest};
await fs.writeFile(path.join(output,'profile-registration.json'),JSON.stringify(declaration,null,2)+'\n',{mode:0o600});
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({status:'DECLARED_INPUTS_PREPARED',content_digest:manifest.digest,file_count:manifest.files.length})+'\n');
