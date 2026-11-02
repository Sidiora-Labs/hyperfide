import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {canonicalJSON, SourceControlError, type SourceScope} from './contracts.js';

export interface SourceCursorBinding {
  scope: SourceScope;
  principal_id: string;
  authority_epoch: string;
  policy_version?:string;
  capability_id?:string;
  query: unknown;
  snapshot: string;
}
interface CursorBody {version:1; binding:string; expires_at:number; position:unknown}
const MAX_CURSOR_BYTES=32768;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJSON(value)).digest('hex');

export class SourceCursorCodec {
  private readonly key:Buffer;
  constructor(key:Uint8Array, private readonly ttlMs=300000) {
    if(key.byteLength<32||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)
      throw new SourceControlError('INVALID_REQUEST','Cursor signing requires a protected key and bounded lifetime');
    this.key=Buffer.from(key);
  }
  encode(binding:SourceCursorBinding,position:unknown,now=Date.now()):string {
    const body:CursorBody={version:1,binding:digest(binding),expires_at:now+this.ttlMs,position};
    const bytes=Buffer.from(canonicalJSON(body));
    if(bytes.length>MAX_CURSOR_BYTES)throw new SourceControlError('LIMIT_EXCEEDED','Query continuation exceeds the bounded cursor size');
    const payload=bytes.toString('base64url');
    return payload+'.'+createHmac('sha256',this.key).update(payload).digest('base64url');
  }
  decode(binding:SourceCursorBinding,token:string,now=Date.now()):unknown {
    const invalid=()=>new SourceControlError('INVALID_CURSOR','Cursor does not match the authorized query');
    if(typeof token!=='string'||token.length>MAX_CURSOR_BYTES*2||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw invalid();
    const [payload,signature]=token.split('.') as [string,string];
    const actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.key).update(payload).digest();
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw invalid();
    let body:CursorBody;
    try {body=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as CursorBody;}catch {throw invalid();}
    if(body.version!==1||body.binding!==digest(binding)||!Number.isSafeInteger(body.expires_at)||body.expires_at<=now)
      throw new SourceControlError('RESNAPSHOT_REQUIRED','Cursor expired or its source authority changed');
    return body.position;
  }
}
