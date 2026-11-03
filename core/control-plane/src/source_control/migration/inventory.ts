import type {SourceContext,SourceMetadata,SourceSQL} from '../metadata.js';
import {sourceScopeValues} from '../metadata.js';
export interface NativeMigrationInventory {open_workspaces:number;pending_uploads:number;unresolved_publications:number;incomplete_imports:number;acknowledged_revisions:number}
export async function migrationInventory(tx:SourceSQL,context:SourceContext):Promise<NativeMigrationInventory>{
 const scope=sourceScopeValues(context.scope);
 const count=async(table:string,condition:string)=>Number((await tx.query('SELECT count(*)::int AS n FROM hyperfide.'+table+' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND '+condition,scope)).rows[0]!.n);
 return {open_workspaces:await count('source_workspaces','closed_at IS NULL'),pending_uploads:await count('source_object_uploads',"status IN ('UPLOADING','UNKNOWN')"),unresolved_publications:await count('source_git_publications',"status IN ('QUEUED','READY','DISPATCHED','OUTCOME_UNKNOWN')"),incomplete_imports:await count('source_git_imports',"state='IMPORTING'"),acknowledged_revisions:await count('source_cutover_acknowledgements','true')};
}
export async function inspectMigrationInventory(metadata:SourceMetadata,context:SourceContext){return metadata.transaction(async tx=>{await metadata.guard(tx,context,'source.migration.read');return migrationInventory(tx,context);});}
