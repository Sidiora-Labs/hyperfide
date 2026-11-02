import {canonicalJSON,SourceControlError} from './contracts.js';

export interface QueryRevision {revision_id:string;root_tree_id:string;parent_revision_ids:readonly string[];descriptor:unknown;created_at?:string}
export interface QueryTreeEntry {name:string;kind:'file'|'directory'|'symlink';mode:string;object_id:string}
export interface SourceQueryReader {
  revision(id:string):Promise<QueryRevision>;
  tree(id:string,after:string|undefined,limit:number):Promise<{entries:readonly QueryTreeEntry[];next_cursor:string|null}>;
  file(revision:string,path:string):Promise<Uint8Array|null>;
}
export interface QueryBudget {max_nodes:number;max_bytes:number;max_ms:number;signal?:AbortSignal}
export interface QueryCoverage {state:'COMPLETE'|'PARTIAL';visited_nodes:number;bytes_read:number;reason?:'NODE_BUDGET'|'TIME_BUDGET'|'PAGE_LIMIT'}
interface WalkState {frontier:string[];seen:string[]}
interface DirectoryWork {path:string;before:string|null;after:string|null;after_name?:string}
export interface DiffState {directories:DirectoryWork[]}
export interface SourceDiffEntry {path:string;kind:'ADDED'|'REMOVED'|'MODIFIED'|'TYPE_CHANGED';before:QueryTreeEntry|null;after:QueryTreeEntry|null}
const order=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function walkState(value:unknown,start:string):WalkState {
  if(value===undefined)return {frontier:[start],seen:[]};
  if(!record(value)||!Array.isArray(value.frontier)||!Array.isArray(value.seen)||
      [...value.frontier,...value.seen].some(v=>typeof v!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v)))
    throw new SourceControlError('INVALID_CURSOR','Malformed history continuation');
  return {frontier:[...value.frontier] as string[],seen:[...value.seen] as string[]};
}
class Meter {
  nodes=0;bytes=0;private readonly deadline:number;
  constructor(readonly budget:QueryBudget) {
    if(!Number.isSafeInteger(budget.max_nodes)||budget.max_nodes<1||budget.max_nodes>8192||
       !Number.isSafeInteger(budget.max_bytes)||budget.max_bytes<1||budget.max_bytes>16777216||
       !Number.isSafeInteger(budget.max_ms)||budget.max_ms<1||budget.max_ms>30000)
      throw new SourceControlError('LIMIT_EXCEEDED','Query budget exceeds service bounds');
    this.deadline=Date.now()+budget.max_ms;
  }
  check():boolean {this.budget.signal?.throwIfAborted();return this.nodes<this.budget.max_nodes&&Date.now()<this.deadline;}
  addBytes(size:number):void {this.bytes+=size;if(this.bytes>this.budget.max_bytes)throw new SourceControlError('LIMIT_EXCEEDED','Query content exceeds the byte budget');}
  coverage(complete:boolean):QueryCoverage {
    return {state:complete?'COMPLETE':'PARTIAL',visited_nodes:this.nodes,bytes_read:this.bytes,
      ...(!complete?{reason:this.nodes>=this.budget.max_nodes?'NODE_BUDGET' as const:Date.now()>=this.deadline?'TIME_BUDGET' as const:'PAGE_LIMIT' as const}:{})};
  }
}
export class SourceQueries {
  constructor(private readonly reader:SourceQueryReader) {}
  async history(start:string,limit:number,budget:QueryBudget,continuation?:unknown) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw new SourceControlError('LIMIT_EXCEEDED','History page limit must be between one and 256');
    const state=walkState(continuation,start),seen=new Set(state.seen),meter=new Meter(budget),entries:QueryRevision[]=[];let outputBytes=0;
    while(state.frontier.length&&entries.length<limit&&meter.check()) {
      const id=state.frontier.shift()!;if(seen.has(id))continue;
      const revision=await this.reader.revision(id),size=Buffer.byteLength(canonicalJSON(revision));meter.nodes++;meter.addBytes(size);
      if(entries.length&&outputBytes+size>524288){state.frontier.unshift(id);break;}
      seen.add(id);entries.push(revision);outputBytes+=size;
      for(const parent of revision.parent_revision_ids)if(!seen.has(parent)&&!state.frontier.includes(parent))state.frontier.push(parent);
    }
    const complete=state.frontier.length===0;
    return {entries,coverage:meter.coverage(complete),continuation:complete?null:{frontier:state.frontier,seen:[...seen]}};
  }
  async ancestry(ancestor:string,descendant:string,budget:QueryBudget,continuation?:unknown) {
    const state=walkState(continuation,descendant),seen=new Set(state.seen),meter=new Meter(budget);
    while(state.frontier.length&&meter.check()) {
      const id=state.frontier.shift()!;if(seen.has(id))continue;
      const revision=await this.reader.revision(id);meter.nodes++;seen.add(id);
      if(id===ancestor)return {is_ancestor:true,coverage:meter.coverage(true),continuation:null};
      for(const parent of revision.parent_revision_ids)if(!seen.has(parent)&&!state.frontier.includes(parent))state.frontier.push(parent);
    }
    const complete=state.frontier.length===0;
    return {is_ancestor:complete?false:null,coverage:meter.coverage(complete),continuation:complete?null:{frontier:state.frontier,seen:[...seen]}};
  }
  async mergeBases(left:string,right:string,budget:QueryBudget) {
    const meter=new Meter(budget),revisions=new Map<string,QueryRevision>();
    const ancestors=async(start:string)=>{
      const pending=[start],seen=new Set<string>();
      while(pending.length&&meter.check()) {
        const id=pending.shift()!;if(seen.has(id))continue;seen.add(id);
        let revision=revisions.get(id);if(!revision){revision=await this.reader.revision(id);revisions.set(id,revision);meter.nodes++;}
        pending.push(...revision.parent_revision_ids.filter(parent=>!seen.has(parent)));
      }
      return {seen,complete:pending.length===0};
    };
    const a=await ancestors(left),b=await ancestors(right);
    if(!a.complete||!b.complete)return {revision_ids:[],coverage:meter.coverage(false)};
    const common=new Set([...a.seen].filter(id=>b.seen.has(id))),nonBases=new Set<string>();
    for(const id of common)for(const parent of revisions.get(id)!.parent_revision_ids)if(common.has(parent))nonBases.add(parent);
    return {revision_ids:[...common].filter(id=>!nonBases.has(id)).sort(order),coverage:meter.coverage(true)};
  }
  async diff(beforeTree:string,afterTree:string,limit:number,budget:QueryBudget,continuation?:unknown) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw new SourceControlError('LIMIT_EXCEEDED','Diff page limit exceeds bounds');
    let state:DiffState={directories:[{path:'',before:beforeTree,after:afterTree}]};
    if(continuation!==undefined) {
      if(!record(continuation)||!Array.isArray(continuation.directories)||continuation.directories.length>4096)
        throw new SourceControlError('INVALID_CURSOR','Malformed diff continuation');
      state={directories:continuation.directories as DirectoryWork[]};
      for(const item of state.directories)if(!record(item)||typeof item.path!=='string'||!['string','object'].includes(typeof item.before)||!['string','object'].includes(typeof item.after))throw new SourceControlError('INVALID_CURSOR','Malformed directory continuation');
    }
    const meter=new Meter(budget),entries:SourceDiffEntry[]=[];
    while(state.directories.length&&entries.length<limit&&meter.check()) {
      const work=state.directories[0]!;
      if(work.before===work.after){state.directories.shift();continue;}
      const amount=Math.min(256,budget.max_nodes-meter.nodes),[a,b]=await Promise.all([
        work.before?this.reader.tree(work.before,work.after_name,amount):Promise.resolve({entries:[],next_cursor:null}),
        work.after?this.reader.tree(work.after,work.after_name,amount):Promise.resolve({entries:[],next_cursor:null})]);
      const old=new Map(a.entries.map(entry=>[entry.name,entry])),next=new Map(b.entries.map(entry=>[entry.name,entry]));
      const names=[...new Set([...old.keys(),...next.keys()])].sort(order).slice(0,amount);
      if(!names.length){state.directories.shift();continue;}
      for(const name of names) {
        if(entries.length>=limit||!meter.check())break;
        const before=old.get(name)??null,after=next.get(name)??null;meter.nodes++;work.after_name=name;
        if(before?.object_id===after?.object_id&&before?.mode===after?.mode&&before?.kind===after?.kind)continue;
        const path=work.path?work.path+'/'+name:name;
        if((before?.kind==='directory'||before===null)&&(after?.kind==='directory'||after===null)) {
          state.directories.push({path,before:before?.object_id??null,after:after?.object_id??null});
          if(before===null||after===null)entries.push({path,kind:before===null?'ADDED':'REMOVED',before,after});
          continue;
        }
        entries.push({path,kind:before===null?'ADDED':after===null?'REMOVED':before.kind!==after.kind?'TYPE_CHANGED':'MODIFIED',before,after});
      }
      const fullyConsumed=work.after_name===names.at(-1)&&a.next_cursor===null&&b.next_cursor===null&&names.length===new Set([...old.keys(),...next.keys()]).size;
      if(fullyConsumed)state.directories.shift();
      if(state.directories.length>4096)throw new SourceControlError('LIMIT_EXCEEDED','Diff frontier exceeds continuation bounds');
    }
    const complete=state.directories.length===0;
    return {entries,coverage:meter.coverage(complete),continuation:complete?null:state};
  }
  async lineMap(before:string,after:string,path:string,budget:QueryBudget) {
    const meter=new Meter(budget);if(budget.max_nodes<2)throw new SourceControlError('LIMIT_EXCEEDED','Line mapping requires two pinned file reads');
    const [a,b]=await Promise.all([this.reader.file(before,path),this.reader.file(after,path)]);
    meter.nodes+=2;meter.addBytes((a?.byteLength??0)+(b?.byteLength??0));
    const old=textLines(a),next=textLines(b);
    if(old===null||next===null)return {binary:true,mappings:[],coverage:meter.coverage(true)};
    const mappings=matchLines(old,next,budget.signal).map(([before_line,after_line])=>({before_line:before_line+1,after_line:after_line+1}));
    return {binary:false,before_lines:old.length,after_lines:next.length,mappings,coverage:meter.coverage(true)};
  }
  async blame(start:string,path:string,budget:QueryBudget,range:{start_line:number;limit:number}={start_line:1,limit:128}) {
    if(!Number.isSafeInteger(range.start_line)||range.start_line<1||!Number.isSafeInteger(range.limit)||range.limit<1||range.limit>256)throw new SourceControlError('INVALID_REQUEST','Blame requires a bounded positive line range');
    const meter=new Meter(budget),initial=await this.reader.file(start,path);meter.addBytes(initial?.byteLength??0);
    if(initial===null)throw new SourceControlError('OBJECT_NOT_AVAILABLE','File is absent at the pinned revision');
    const lines=textLines(initial);if(lines===null)return {binary:true,lines:[],next_line:null,coverage:meter.coverage(true),strategy:'FIRST_PARENT'};
    const selected=lines.slice(range.start_line-1,range.start_line-1+range.limit),origins=new Map<number,string>();
    const unresolved=new Map(selected.map((_,index)=>[index+range.start_line-1,index+range.start_line-1]));
    let current=start,currentLines=lines;
    while(unresolved.size&&meter.check()) {
      const revision=await this.reader.revision(current);meter.nodes++;
      const parent=revision.parent_revision_ids[0];
      if(!parent){for(const original of unresolved.keys())origins.set(original,current);unresolved.clear();break;}
      const bytes=await this.reader.file(parent,path);meter.addBytes(bytes?.byteLength??0);
      const parentLines=textLines(bytes);
      if(parentLines===null)throw new SourceControlError('HISTORY_REDACTED','A binary predecessor cannot establish text line ancestry');
      const prior=new Map(matchLines(parentLines,currentLines,budget.signal).map(([a,b])=>[b,a]));
      for(const [original,index] of unresolved) {
        const parentIndex=prior.get(index);
        if(parentIndex===undefined){origins.set(original,current);unresolved.delete(original);}else unresolved.set(original,parentIndex);
      }
      current=parent;currentLines=parentLines;
    }
    return {binary:false,strategy:'FIRST_PARENT',lines:selected.map((content,index)=>({line:index+range.start_line,content,origin_revision_id:origins.get(index+range.start_line-1)??null})),next_line:range.start_line-1+selected.length<lines.length?range.start_line+selected.length:null,coverage:meter.coverage(unresolved.size===0)};
  }
}
function textLines(bytes:Uint8Array|null):string[]|null {
  if(bytes===null)return [];
  if(bytes.byteLength>2*1024*1024)throw new SourceControlError('LIMIT_EXCEEDED','Text query requires a file no larger than 2 MiB');
  try {const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))return null;return text.length?text.match(/[^\n]*\n|[^\n]+$/g)??[]:[];}catch{return null;}
}
function matchLines(before:readonly string[],after:readonly string[],signal?:AbortSignal):Array<[number,number]> {
  const cells=(before.length+1)*(after.length+1);
  if(cells>2000000)throw new SourceControlError('LIMIT_EXCEEDED','Exact line comparison exceeds its matrix budget');
  const width=after.length+1,table=new Uint32Array(cells);
  for(let a=before.length-1;a>=0;a--){signal?.throwIfAborted();for(let b=after.length-1;b>=0;b--)table[a*width+b]=before[a]===after[b]?table[(a+1)*width+b+1]!+1:Math.max(table[(a+1)*width+b]!,table[a*width+b+1]!);}
  const result:Array<[number,number]>=[];let a=0,b=0;
  while(a<before.length&&b<after.length){if(before[a]===after[b]){result.push([a++,b++]);}else if(table[(a+1)*width+b]!>=table[a*width+b+1]!)a++;else b++;}
  return result;
}
