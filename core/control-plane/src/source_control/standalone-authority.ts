import path from 'node:path';
import {FoundationError} from '../policy/programme.js';
import {SourceControlError,parseUUID} from './contracts.js';
import type {SourceMetadataOptions} from './metadata.js';
import type {ServiceResources} from '../storage/runtime.js';
import {FileExternalAuthorityJournal,type ExternalAuthorityAttestation} from '../storage/authority_journal.js';
import {assertExternalAuthorityCurrent,lookupAuthorityActivation} from '../storage/durability.js';
import type {AuthorityTransaction} from '../transport/protocol.js';

class StandaloneAuthorityFailure extends FoundationError {
 constructor(readonly source:SourceControlError){super(source.code,source.message);}
}

export function standaloneSourceAuthority(resources:ServiceResources,env:Readonly<NodeJS.ProcessEnv>,signal:AbortSignal):{current:()=>Promise<ExternalAuthorityAttestation>;transaction:NonNullable<SourceMetadataOptions['transaction']>} {
 const deployment=env.HYPERFIDE_DEPLOYMENT_ID,directory=env.HYPERFIDE_AUTHORITY_JOURNAL_DIR;
 if(!deployment||!directory||!path.isAbsolute(directory))throw new SourceControlError('EXTERNAL_JOURNAL_REQUIRED','Standalone source requires a deployment identity and absolute private external authority journal directory');
 parseUUID(deployment,'HYPERFIDE_DEPLOYMENT_ID');
 const journal=new FileExternalAuthorityJournal(directory,input=>lookupAuthorityActivation(resources,input));
 const current=async()=>{
  try{return await assertExternalAuthorityCurrent(resources,journal,{deployment_id:deployment,signal,timeoutMs:5000});}
  catch(error){if(error instanceof SourceControlError)throw error;const code=error instanceof FoundationError&&/^(EXTERNAL_|RESTORED_|AUTHORITY_|PRIMARY_)[A-Z_]+$/.test(error.code)?error.code:'EXTERNAL_AUTHORITY_UNAVAILABLE';throw new SourceControlError(code,'External source authority is unavailable or stale','REFRESH_AUTHORITY');}
 };
 const validate=async(tx:AuthorityTransaction,attestation:ExternalAuthorityAttestation)=>{
  signal.throwIfAborted();
  const row=(await tx.query("SELECT epoch::text,proof_digest,clock_timestamp() AS now FROM hyperfide.authority_epochs WHERE deployment_id=$1 AND state='ACTIVE' FOR SHARE",[deployment])).rows[0];
  const now=row?new Date(row.now).getTime():NaN;
  if(!row||row.epoch!==attestation.epoch||row.proof_digest!==attestation.evidence_digest||attestation.deployment_id!==deployment)
   throw new StandaloneAuthorityFailure(new SourceControlError('RESTORED_AUTHORITY_STALE','Independent authority differs from the current source database'));
  if(!Number.isFinite(now)||Date.parse(attestation.expires_at)<=now||Date.parse(attestation.observed_at)>now+1000)
   throw new StandaloneAuthorityFailure(new SourceControlError('EXTERNAL_JOURNAL_STALE','External authority attestation expired before source transaction admission'));
 };
 const transaction:NonNullable<SourceMetadataOptions['transaction']>=async body=>{
  const attestation=await current();
  try{return await resources.gateway.withPrimaryTransaction({timeoutMs:5000,maxRetries:2,signal,guard:tx=>validate(tx,attestation)},async tx=>{
   const result=await body(tx);
   await validate(tx,attestation);
   return result;
  });}catch(error){if(error instanceof StandaloneAuthorityFailure)throw error.source;throw error;}
 };
 return {current,transaction};
}
