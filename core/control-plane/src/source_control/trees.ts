import {compareUTF8,parseRepositoryPath,parseTreeEntry,sourceError,SOURCE_FORMAT} from './contracts.js';
import type {TreeEntry} from './contracts.js';
import {SourceObjectService,decodeTreeNode,encodeTreeNode,treeNameKey} from './objects.js';
import type {TreeNode} from './objects.js';
import type {SourceStorageScope} from './storage_contract.js';
export type TreePatch={path:string;operation:'remove'}|{path:string;operation:'put';kind:TreeEntry['kind'];mode:TreeEntry['mode'];object_id:string};
export interface TreeMetrics {nodes_read:number;nodes_written:number}
export class PersistentTree {
 constructor(readonly store:SourceObjectService){}
 async empty(scope:SourceStorageScope):Promise<string>{return(await this.store.put(scope,'tree-leaf',encodeTreeNode({kind:'tree-leaf',prefix:'',entries:[],count:0}))).object_id;}
 async fromEntries(scope:SourceStorageScope,entries:readonly TreeEntry[]):Promise<{root_tree_id:string;metrics:TreeMetrics}>{
  if(entries.length>4096)sourceError('TREE_LIMIT','Initial directory construction requires a bounded entry batch');
  const sorted=entries.map(parseTreeEntry).sort((a,b)=>compareUTF8(a.name,b.name));for(let i=1;i<sorted.length;i++)if(sorted[i-1]!.name===sorted[i]!.name)sourceError('INVALID_TREE','Duplicate directory entry');
  const metrics={nodes_read:0,nodes_written:0},root=await this.build(scope,'',sorted,metrics);return {root_tree_id:root.id,metrics};
 }
 private async read(scope:SourceStorageScope,id:string,metrics?:TreeMetrics):Promise<TreeNode>{const object=await this.store.read(scope,id);if(object.kind!=='tree-leaf'&&object.kind!=='tree-index')sourceError('INVALID_TREE','Directory root is not a tree node');if(metrics)metrics.nodes_read++;return decodeTreeNode(object.kind,object.payload);}
 private async write(scope:SourceStorageScope,node:TreeNode,metrics:TreeMetrics):Promise<{id:string;count:number}>{const object=await this.store.put(scope,node.kind,encodeTreeNode(node));metrics.nodes_written++;return {id:object.object_id,count:node.count};}
 private async find(scope:SourceStorageScope,id:string,name:string,metrics?:TreeMetrics):Promise<TreeEntry|null>{let node=await this.read(scope,id,metrics);const key=treeNameKey(name);while(node.kind==='tree-index'){const child=node.children.find(c=>c.digit===key[node.prefix.length]);if(!child)return null;node=await this.read(scope,child.object_id,metrics);}return node.entries.find(e=>e.name===name)??null;}
 async lookup(scope:SourceStorageScope,root:string,path:string):Promise<TreeEntry|null>{if((await this.read(scope,root)).prefix!=='')sourceError('INVALID_TREE','Directory root cannot be an internal radix node');const parts=parseRepositoryPath(path).split('/');let current=root;for(let i=0;i<parts.length;i++){const entry=await this.find(scope,current,parts[i]!);if(!entry)return null;if(i===parts.length-1)return entry;if(entry.kind!=='directory')sourceError('PATH_CONFLICT','A path ancestor is not a directory');current=entry.object_id;}return null;}
 async list(scope:SourceStorageScope,root:string,options:{cursor?:string;limit:number}):Promise<{entries:TreeEntry[];next_cursor:string|null}>{
 if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>256)sourceError('PAGE_LIMIT','Tree page limit must be between one and256');
 const cursor=options.cursor;if(cursor!==undefined&&(parseRepositoryPath(cursor).includes('/')))sourceError('INVALID_CURSOR','Tree cursor must be one exact name');const key=cursor===undefined?null:treeNameKey(cursor),found:TreeEntry[]=[];
 const visit=async(id:string):Promise<void>=>{if(found.length>options.limit)return;const node=await this.read(scope,id);if(id===root&&node.prefix!=='')sourceError('INVALID_TREE','Directory root cannot be an internal radix node');if(key!==null&&!key.startsWith(node.prefix)&&node.prefix<key)return;
  if(node.kind==='tree-leaf'){for(const entry of node.entries){if(cursor===undefined||compareUTF8(entry.name,cursor)>0)found.push(entry);if(found.length>options.limit)break;}}
  else for(const child of node.children){await visit(child.object_id);if(found.length>options.limit)break;}
 };await visit(root);const more=found.length>options.limit,entries=found.slice(0,options.limit);return {entries,next_cursor:more?entries.at(-1)!.name:null};
 }
 private async build(scope:SourceStorageScope,prefix:string,entries:TreeEntry[],metrics:TreeMetrics):Promise<{id:string;count:number}>{
 if(entries.length<=SOURCE_FORMAT.max_tree_entries)return this.write(scope,{kind:'tree-leaf',prefix,entries,count:entries.length},metrics);
 const groups=new Map<string,TreeEntry[]>();for(const entry of entries){const digit=treeNameKey(entry.name)[prefix.length];if(digit===undefined)sourceError('INVALID_TREE','Duplicate or impossible radix entry');const group=groups.get(digit)??[];group.push(entry);groups.set(digit,group);}
 const children:{digit:string;object_id:string;count:number}[]=[];for(const [digit,group]of[...groups].sort(([a],[b])=>a<b?-1:1)){const child=await this.build(scope,prefix+digit,group,metrics);children.push({digit,object_id:child.id,count:child.count});}
 return this.write(scope,{kind:'tree-index',prefix,children,count:entries.length},metrics);
 }
 private async gather(scope:SourceStorageScope,id:string,metrics:TreeMetrics):Promise<TreeEntry[]>{const node=await this.read(scope,id,metrics);if(node.count>256)sourceError('TREE_LIMIT','Radix merge may only traverse a bounded small subtree');if(node.kind==='tree-leaf')return node.entries;const entries:TreeEntry[]=[];for(const child of node.children)entries.push(...await this.gather(scope,child.object_id,metrics));return entries;}
 private async updateNames(scope:SourceStorageScope,id:string,changes:ReadonlyMap<string,TreeEntry|null>,metrics:TreeMetrics):Promise<{id:string;count:number}>{
 const node=await this.read(scope,id,metrics);
 if(node.kind==='tree-leaf'){
  const entries=new Map(node.entries.map(entry=>[entry.name,entry]));let changed=false;
  for(const [name,replacement] of changes){const prior=entries.get(name);if(replacement===null){if(entries.delete(name))changed=true;}else if(!prior||JSON.stringify(prior)!==JSON.stringify(replacement)){entries.set(name,replacement);changed=true;}}
  if(!changed)return {id,count:node.count};return this.build(scope,node.prefix,[...entries.values()].sort((a,b)=>compareUTF8(a.name,b.name)),metrics);
 }
 const groups=new Map<string,Map<string,TreeEntry|null>>();
 for(const [name,replacement] of changes){const digit=treeNameKey(name)[node.prefix.length]!;const group=groups.get(digit)??new Map<string,TreeEntry|null>();group.set(name,replacement);groups.set(digit,group);}
 const children=new Map(node.children.map(child=>[child.digit,child]));let changed=false;
 for(const [digit,group] of groups){const prior=children.get(digit);if(!prior&&[...group.values()].every(entry=>entry===null))continue;const result=prior?await this.updateNames(scope,prior.object_id,group,metrics):await this.build(scope,node.prefix+digit,[...group.values()].filter((entry):entry is TreeEntry=>entry!==null).sort((a,b)=>compareUTF8(a.name,b.name)),metrics);
  if(prior?.object_id===result.id)continue;if(!prior&&result.count===0)continue;changed=true;if(result.count)children.set(digit,{digit,object_id:result.id,count:result.count});else children.delete(digit);
 }
 if(!changed)return {id,count:node.count};
 const sorted=[...children.values()].sort((a,b)=>a.digit<b.digit?-1:1),count=sorted.reduce((total,child)=>total+child.count,0);
 if(count<=256){const entries:TreeEntry[]=[];for(const child of sorted)entries.push(...await this.gather(scope,child.object_id,metrics));return this.build(scope,node.prefix,entries.sort((a,b)=>compareUTF8(a.name,b.name)),metrics);}
 return this.write(scope,{kind:'tree-index',prefix:node.prefix,children:sorted,count},metrics);
 }
 private async updatePaths(scope:SourceStorageScope,root:string,patches:readonly {parts:string[];entry:TreeEntry|null}[],metrics:TreeMetrics):Promise<string>{
 const groups=new Map<string,{parts:string[];entry:TreeEntry|null}[]>();for(const patch of patches){const name=patch.parts[0]!,group=groups.get(name)??[];group.push(patch);groups.set(name,group);}
 const changes=new Map<string,TreeEntry|null>();
 for(const [name,group] of groups){const first=group[0]!;if(first.parts.length===1){changes.set(name,first.entry);continue;}
  const prior=await this.find(scope,root,name,metrics);if(prior&&prior.kind!=='directory')sourceError('PATH_CONFLICT','A path ancestor is not a directory');if(!prior&&group.every(patch=>patch.entry===null))continue;
  const childRoot=prior?.object_id??await this.empty(scope),next=await this.updatePaths(scope,childRoot,group.map(patch=>({parts:patch.parts.slice(1),entry:patch.entry})),metrics);
  if(prior?.object_id!==next)changes.set(name,parseTreeEntry({name,kind:'directory',mode:'040000',object_id:next}));
 }
 return changes.size?(await this.updateNames(scope,root,changes,metrics)).id:root;
 }
 async patch(scope:SourceStorageScope,root:string,patches:readonly TreePatch[]):Promise<{root_tree_id:string;metrics:TreeMetrics}>{
 if(!Array.isArray(patches)||patches.length>4096)sourceError('PATCH_LIMIT','A bounded explicit patch list is required');
 const normalized=patches.map(p=>{const path=parseRepositoryPath(p.path);if(p.operation!=='put'&&p.operation!=='remove')sourceError('INVALID_PATCH','Unknown tree mutation');const name=path.split('/').at(-1)!;return {path,entry:p.operation==='remove'?null:parseTreeEntry({name,kind:p.kind,mode:p.mode,object_id:p.object_id})};}).sort((a,b)=>compareUTF8(a.path,b.path));
 for(let i=1;i<normalized.length;i++){const prior=normalized[i-1]!.path,current=normalized[i]!.path;if(prior===current||current.startsWith(prior+'/'))sourceError('PATCH_CONFLICT','Duplicate or overlapping patch paths require separate revisions');}
 const metrics={nodes_read:0,nodes_written:0};if((await this.read(scope,root,metrics)).prefix!=='')sourceError('INVALID_TREE','Directory root cannot be an internal radix node');const current=await this.updatePaths(scope,root,normalized.map(patch=>({parts:patch.path.split('/'),entry:patch.entry})),metrics);return {root_tree_id:current,metrics};
 }
 async apply(scope:SourceStorageScope,root:string,changes:readonly {path:string;entry:TreeEntry|null}[]):Promise<{root_tree_id:string;metrics:TreeMetrics}>{return this.patch(scope,root,changes.map(c=>c.entry===null?{path:c.path,operation:'remove'}:{path:c.path,operation:'put',kind:c.entry.kind,mode:c.entry.mode,object_id:c.entry.object_id}));}
}
