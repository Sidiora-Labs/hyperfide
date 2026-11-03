import {SourceControlError} from './contracts.js';
import {sourceScopeValues,type SourceContext,type SourceSQL} from './metadata.js';

export async function assertManagedObjectUploads(tx:SourceSQL,context:SourceContext,objects:readonly string[]):Promise<void> {
 if(!context.workspace||objects.length===0)return;
 const ids=[...new Set(objects)];
 const rows=(await tx.query("SELECT DISTINCT object_id FROM hyperfide.source_object_uploads WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_principal_id=$4 AND status='VERIFIED' AND object_id=ANY($5::text[])",[...sourceScopeValues(context.scope),context.principal_id,ids])).rows;
 if(rows.length!==ids.length)throw new SourceControlError('SOURCE_OBJECT_NOT_OWNED','Managed writes require bytes uploaded by the assigned worker');
}
