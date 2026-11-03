import {
  decodeSourceResponse,encodeSourceRequest,parseSourceScope,SourceControlError,
  type SourceAction,type SourceAuthority,type SourceRequest,type SourceScope,
} from './contracts.js';
import type {SourceMergeRequest,SourceRebaseRequest,SourceRevertRequest,SourceResumeRequest,SourceTransformationResult} from './transformations.js';
import type {
 SourceCreateDomainRequest,SourceConfigureDomainRequest,SourceCreateCandidateRequest,SourceQualifyCandidateRequest,
 SourceAcceptCandidateRequest,SourceIntegrationDomain,SourceCandidateRecord,SourceCandidateQualification,SourceAcceptanceReceipt,
 SourceCreateCustodyRequest,SourceCustodyReceipt,SourcePublishEvidenceRequest,SourceEvidenceReceipt,SourceRevocationReceipt,
} from './acceptance.js';
import type {SourceFleetSelection,SourceFleetSelectRequest,SourceFleetQualificationReceipt,SourceNativeManifestRequest,SourceNativeManifest,SourceFleetQualifyRequest,SourceBindFleetRunRequest,SourceFleetRunBinding,SourceFleetAssignmentRequest,SourceFleetAssignment,SourceFleetSubmitRequest,SourceFleetSubmission} from './fleet.js';
import type {SourceCreatePublicationRequest,SourcePublicationResult} from './publication.js';

export interface SourceClientOptions {
  endpoint:string;
  scope:SourceScope;
  token:string|(()=>string|Promise<string>);
  fetch?:typeof globalThis.fetch;
  timeout_ms?:number;
}
export interface SourceCallOptions {
  operation_id?:string;idempotency_key?:string;authority?:SourceAuthority;signal?:AbortSignal;
}
export class SourceControlClient {
  readonly scope:SourceScope;
  private readonly endpoint:string;
  private readonly transport:typeof globalThis.fetch;
  private readonly timeout:number;
  constructor(private readonly options:SourceClientOptions) {
    const endpoint=new URL(options.endpoint);
    if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)))
      throw new SourceControlError('INVALID_ENDPOINT','Source API requires a trusted HTTPS endpoint or local development server');
    this.endpoint=endpoint.toString().replace(/\/$/,'');this.scope=parseSourceScope(options.scope);this.transport=options.fetch??globalThis.fetch;
    this.timeout=options.timeout_ms??30000;
    if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>300000)throw new SourceControlError('INVALID_REQUEST','Source client timeout exceeds bounds');
  }
  async call<T=unknown>(action:SourceAction,input:unknown,options:SourceCallOptions={}):Promise<T> {
    const operation_id=options.operation_id??globalThis.crypto.randomUUID();
    const request:SourceRequest={protocol_version:1,scope:this.scope,operation_id,action,input,
      ...(options.idempotency_key?{idempotency_key:options.idempotency_key}:{}),...(options.authority?{authority:options.authority}:{})};
    const body=encodeSourceRequest(request),token=typeof this.options.token==='function'?await this.options.token():this.options.token;
    if(!token||/[\r\n]/.test(token))throw new SourceControlError('INVALID_REQUEST','A source credential is required');
    const signal=AbortSignal.any([AbortSignal.timeout(this.timeout),...(options.signal?[options.signal]:[])]);
    let response:Response;
    try {response=await this.transport(this.endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:body as unknown as BodyInit,signal});}
    catch {throw new SourceControlError('OUTCOME_UNKNOWN','Source request lost its response; resolve the original operation','RETRY_SAME_OPERATION','UNKNOWN',{operation_id});}
    const maximum=action==='source.fleet.manifest'?96*1024*1024:action==='source.objects.read'||action==='source.objects.put'?12*1024*1024:1024*1024;
    const chunks:Uint8Array[]=[];let size=0;
    try {
      const reader=response.body?.getReader();if(!reader)throw new SourceControlError('INVALID_RESPONSE','Source server returned no response body');
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum){await reader.cancel();throw new SourceControlError('LIMIT_EXCEEDED','Source response exceeds the action byte bound');}chunks.push(part.value);}
    }catch(error){if(error instanceof SourceControlError)throw error;throw new SourceControlError('OUTCOME_UNKNOWN','Source response was interrupted','RETRY_SAME_OPERATION','UNKNOWN',{operation_id});}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    const decoded=decodeSourceResponse(bytes,{action});
    if(decoded.operation_id!==operation_id)throw new SourceControlError('INVALID_RESPONSE','Source response belongs to another operation');
    if('error' in decoded)throw new SourceControlError(decoded.error.code,decoded.error.message,decoded.error.retry,decoded.error.outcome,{...decoded.error.details,operation_id});
    if(!response.ok)throw new SourceControlError('INVALID_RESPONSE','Source server returned a successful envelope with a failing HTTP status');
    return decoded.result as T;
  }
  capabilities(options?:SourceCallOptions){return this.call('source.capabilities',{},options);}
  revision(revision_id:string,options?:SourceCallOptions){return this.call('source.revisions.read',{revision_id},options);}
  object(object_id:string,options?:SourceCallOptions){return this.call<{object_id:string;kind:string;payload_base64:string;byte_length:string}>('source.objects.read',{object_id},options);}
  tree(tree_id:string,page:{limit?:number;cursor?:string}={},options?:SourceCallOptions){return this.call('source.trees.entries',{tree_id,...page},options);}
  lookup(tree_id:string,path:string,options?:SourceCallOptions){return this.call('source.trees.lookup',{tree_id,path},options);}
  createRevision(input:unknown,options:SourceCallOptions){return this.call('source.revisions.create',input,options);}
  operation(operation_id:string,options?:SourceCallOptions){return this.call('source.operations.read',{operation_id},options);}
  merge(input:SourceMergeRequest,options:SourceCallOptions){return this.call<SourceTransformationResult>('source.transforms.merge',input,options);}
  rebase(input:SourceRebaseRequest,options:SourceCallOptions){return this.call<SourceTransformationResult>('source.transforms.rebase',input,options);}
  revert(input:SourceRevertRequest,options:SourceCallOptions){return this.call<SourceTransformationResult>('source.transforms.revert',input,options);}
  transformation(operation_id:string,options?:SourceCallOptions){return this.call<SourceTransformationResult>('source.transforms.read',{operation_id},options);}
  resumeTransformation(input:SourceResumeRequest,options?:SourceCallOptions){return this.call<SourceTransformationResult>('source.transforms.resume',input,options);}
  selectFleetSource(input:SourceFleetSelectRequest,options:SourceCallOptions){return this.call<SourceFleetSelection>('source.fleet.select',input,options);}
  fleetSourceSelection(input:{run_id:string;selection_id:string},options?:SourceCallOptions){return this.call<SourceFleetSelection>('source.fleet.selection',input,options);}
  qualifyFleetTask(input:SourceFleetQualifyRequest,options:SourceCallOptions){return this.call<SourceFleetQualificationReceipt>('source.fleet.qualify',input,options);}
  nativeFleetManifest(input:SourceNativeManifestRequest,options?:SourceCallOptions){return this.call<SourceNativeManifest>('source.fleet.manifest',input,options);}
  bindFleetRun(input:SourceBindFleetRunRequest,options:SourceCallOptions){return this.call<SourceFleetRunBinding>('source.fleet.bind-run',input,options);}
  assignFleetSource(input:SourceFleetAssignmentRequest,options:SourceCallOptions){return this.call<SourceFleetAssignment>('source.fleet.assign',input,options);}
  fleetAssignment(assignment_id:string,options?:SourceCallOptions){return this.call<SourceFleetAssignment>('source.fleet.read',{assignment_id},options);}
  submitFleetSource(input:SourceFleetSubmitRequest,options:SourceCallOptions){return this.call<SourceFleetSubmission>('source.fleet.submit',input,options);}
  fleetSubmission(submission_id:string,options?:SourceCallOptions){return this.call<SourceFleetSubmission>('source.fleet.submission',{submission_id},options);}
  createDomain(input:SourceCreateDomainRequest,options:SourceCallOptions){return this.call<SourceIntegrationDomain>('source.domains.create',input,options);}
  domain(domain_id:string,options?:SourceCallOptions){return this.call<SourceIntegrationDomain>('source.domains.read',{domain_id},options);}
  configureDomain(input:SourceConfigureDomainRequest,options:SourceCallOptions){return this.call<SourceIntegrationDomain>('source.domains.configure',input,options);}
  createCandidate(input:SourceCreateCandidateRequest,options:SourceCallOptions){return this.call<SourceCandidateRecord>('source.candidates.create',input,options);}
  candidate(candidate_id:string,options?:SourceCallOptions){return this.call<SourceCandidateRecord>('source.candidates.read',{candidate_id},options);}
  qualifyCandidate(input:SourceQualifyCandidateRequest,options:SourceCallOptions){return this.call<SourceCandidateQualification>('source.candidates.qualify',input,options);}
  acceptCandidate(input:SourceAcceptCandidateRequest,options:SourceCallOptions){return this.call<SourceAcceptanceReceipt>('source.acceptance.accept',input,options);}
  acceptance(acceptance_id:string,options?:SourceCallOptions){return this.call<SourceAcceptanceReceipt>('source.acceptance.read',{acceptance_id},options);}
  createSourceCustody(input:SourceCreateCustodyRequest,options:SourceCallOptions){return this.call<SourceCustodyReceipt>('source.assurance.custody.create',input,options);}
  publishSourceEvidence(input:SourcePublishEvidenceRequest,options:SourceCallOptions){return this.call<SourceEvidenceReceipt>('source.assurance.publish',input,options);}
  revokeSourceEvidence(evidence_id:string,options:SourceCallOptions){return this.call<SourceRevocationReceipt>('source.assurance.revoke',{evidence_id},options);}
  revokeSourceCustody(custody_id:string,options:SourceCallOptions){return this.call<SourceRevocationReceipt>('source.assurance.revoke',{custody_id},options);}
  createPublication(input:SourceCreatePublicationRequest,options:SourceCallOptions){return this.call<SourcePublicationResult>('source.publications.create',input,options);}
  publication(operation_id:string,options?:SourceCallOptions){return this.call<SourcePublicationResult>('source.publications.read',{operation_id},options);}
  resumePublication(operation_id:string,options?:SourceCallOptions){return this.call<SourcePublicationResult>('source.publications.resume',{operation_id},options);}
  cancelPublication(operation_id:string,options?:SourceCallOptions){return this.call<SourcePublicationResult>('source.publications.cancel',{operation_id},options);}
}
