import {FoundationError,object} from '../../policy/programme.js';
import type {ProviderScope} from '../contract.js';
import {digestDocument,type BlaxelInventoryNamespace} from '../pools.js';
import type {GreenfieldInventory} from '../../recovery/fencing.js';
import {configuredBlaxelSDK} from './images.js';

const API_VERSION='2026-04-28';
const MAX_PAGES=500, PAGE_SIZE=200;
function fail():never{throw new FoundationError('GREENFIELD_EMPTINESS_UNPROVEN','Complete configured Blaxel pool inventory could not be established');}
interface ListSdk {
 listSandboxes(options:{query:{limit:number;showTerminated:true;sort:'name:asc';cursor?:string};headers:Record<string,string>;signal:AbortSignal;throwOnError:false}):Promise<{data?:unknown;response?:Response;error?:unknown}>;
}
function state(value:unknown):string{
 if(value==='TERMINATED')return 'DESTROYED';
 if(value==='DELETING')return 'DESTROYING';
 if(value==='DEPLOYED')return 'RUNNING';
 if(value==='FAILED')return 'FAILED';
 if(['ARCHIVED','DEACTIVATED'].includes(String(value)))return 'STOPPED';
 if(['BUILDING','DEPLOYING','UPLOADING','UNARCHIVING'].includes(String(value)))return 'CREATING';
 return 'UNKNOWN';
}
/** Enumerates the account completely and reports only the signed pool namespace. */
export async function completeBlaxelGreenfieldInventory(env:Readonly<NodeJS.ProcessEnv>,scope:ProviderScope,namespace:BlaxelInventoryNamespace,signal:AbortSignal):Promise<GreenfieldInventory>{
 if(scope.provider!=='blaxel'||env.HF_BLAXEL_ACCOUNT_ID!==scope.provider_account_id||env.HF_BLAXEL_WORKSPACE!==scope.environment_id||
  !namespace||namespace.schema_version!==1||namespace.kind!=='HYPERFIDE_SCOPE_LABEL'||namespace.name_prefix!=='hf-')fail();
 signal.throwIfAborted();
 await configuredBlaxelSDK({env});
 const packageName:string='@blaxel/core',loaded:unknown=await import(packageName);
 if(!object(loaded)||typeof loaded.listSandboxes!=='function')fail();
 const api=loaded as unknown as ListSdk,scopeDigest=digestDocument(scope),namespaceDigest=digestDocument(namespace);
 const items:GreenfieldInventory['items']=[],seenNames=new Set<string>(),seenCursors=new Set<string>();
 let cursor:string|undefined,accountItems=0,pages=0;
 for(;;){
  signal.throwIfAborted();
  if(++pages>MAX_PAGES)fail();
  let response:Awaited<ReturnType<ListSdk['listSandboxes']>>;
  try{response=await api.listSandboxes({query:{limit:PAGE_SIZE,showTerminated:true,sort:'name:asc',...(cursor?{cursor}:{})},headers:{'Blaxel-Version':API_VERSION},signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),throwOnError:false});}
  catch{fail();}
  if(response.response?.status!==200||response.error!==undefined||!object(response.data)||!Array.isArray(response.data.data)||response.data.data.length>PAGE_SIZE||!object(response.data.meta))fail();
  const data=response.data.data,meta=response.data.meta;
  if(typeof meta.hasMore!=='boolean'||meta.hasMore&&(typeof meta.nextCursor!=='string'||!meta.nextCursor||meta.nextCursor.length>4096))fail();
  for(const entry of data){
   if(!object(entry)||!object(entry.metadata)||!object(entry.spec)||typeof entry.metadata.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,48}$/.test(entry.metadata.name)||
    entry.metadata.workspace!==scope.environment_id||typeof entry.spec.region!=='string'||seenNames.has(entry.metadata.name))fail();
   seenNames.add(entry.metadata.name);accountItems++;
   const labels=entry.metadata.labels;
   if(entry.spec.region!==scope.region||!object(labels)||labels['hyperfide-scope']!==scopeDigest)continue;
   if(!entry.metadata.name.startsWith(namespace.name_prefix))fail();
   items.push({native_sandbox_id:entry.metadata.name,provider_state:state(entry.status)});
  }
  if(!meta.hasMore)break;
  const next=meta.nextCursor as string;
  if(seenCursors.has(next))fail();seenCursors.add(next);cursor=next;
 }
 return {scope,transport:'AVAILABLE',enumeration_complete:true,items,observed_at:new Date().toISOString(),
  provenance:{schema_version:1,scope_kind:'OWNED_POOL_NAMESPACE',namespace_digest:namespaceDigest,scope_digest:scopeDigest,api_version:API_VERSION,account_items:accountItems,excluded_items:accountItems-items.length,pages,consistency:'BEST_EFFORT'}};
}
