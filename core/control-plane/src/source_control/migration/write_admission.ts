import {SourceControlError} from '../contracts.js';
import type {SourceContext,SourceSQL} from '../metadata.js';
const imports=new WeakSet<object>();
export function sourceImportContext(context:SourceContext):SourceContext {const scoped={...context};imports.add(scoped);return scoped;}
const values=(context:SourceContext)=>[context.scope.organisation_id,context.scope.repository_id,context.scope.security_domain_id];
async function gate(tx:SourceSQL,context:SourceContext){if(!(await tx.query("SELECT to_regclass('hyperfide.source_native_cutovers') IS NOT NULL AS present")).rows[0]?.present)return null;return (await tx.query("SELECT migration_id,state,active_epoch::text FROM hyperfide.source_native_cutovers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY (state<>'ABORTED') DESC,created_at DESC LIMIT 1 FOR SHARE",values(context))).rows[0]??null;}
export async function assertNativeWriteAdmission(tx:SourceSQL,context:SourceContext,action:string):Promise<void>{
 if(!/\.(put|patch|create|open|prepare|complete|cancel|checkpoint|widen|close|ack|manage|merge|rebase|revert|resume|configure|qualify|accept|publish|revoke|bind-run|assign|submit|select|acquire|release|discover|collect|build|reserve|reconcile)$/.test(action))return;
 if(action.startsWith('source.migration.')||action.startsWith('source.imports.')||action.startsWith('source.projections.')||action.startsWith('source.objects.')||action.startsWith('source.uploads.')||['source.workspaces.close','source.publications.cancel','source.operations.cancel','source.retention.release'].includes(action))return;
 const row=await gate(tx,context);if(!row)return;
 if(imports.has(context)&&action==='source.revisions.create'&&['SHADOW','READY','QUIESCED'].includes(row.state))return;
 if(['SHADOW','READY','QUIESCED'].includes(row.state)&&['source.domains.create','source.candidates.create','source.candidates.qualify','source.assurance.custody.create','source.assurance.publish','source.assurance.revoke','source.acceptance.accept'].includes(action))return;
 if(row.state!=='NATIVE'||row.active_epoch!==context.authority_epoch)throw new SourceControlError('NATIVE_WRITER_FENCED','Native writer admission is closed for this migration generation');
}
export async function recordNativeRevisionAcknowledgement(tx:SourceSQL,context:SourceContext,revisionId:string):Promise<void>{
 if(imports.has(context))return;const row=await gate(tx,context);if(!row)return;
 if(row.state!=='NATIVE'||row.active_epoch!==context.authority_epoch)throw new SourceControlError('NATIVE_WRITER_FENCED','Acknowledgment requires active native authority');
 await tx.query('INSERT INTO hyperfide.source_cutover_acknowledgements(organisation_id,repository_id,security_domain_id,migration_id,revision_id,authority_epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[...values(context),row.migration_id,revisionId,context.authority_epoch]);
}
