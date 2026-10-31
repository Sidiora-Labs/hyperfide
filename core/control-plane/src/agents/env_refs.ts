import type {PrimaryTransaction} from '../storage/transactions.js';
import {object} from '../policy/programme.js';
import {launchEnvReferences} from '../runner/dispatch.js';
import {agentError} from './sessions.js';

/** Task 3.15 (D17): the producer of a native launch's secret references.
 * The task declares NAME -> 'secret-ref:ID' as `env_refs` in its definition (the
 * execution packet carries that definition verbatim); the environment profile of
 * the pool that owns the worker's sandbox is the allowlist. Admission calls this
 * once per launch selection, the launch plan stores the result, and the START
 * route re-checks it against the current profile. Names and references only. */
export type LaunchEnvReferences=Readonly<Record<string,string>>;

/** The `env_refs` declaration of a task definition, in the flat or the kvx
 * section shape that hierarchy/packets.ts definitionField also reads. */
export function taskDefinitionEnvReferences(definition:unknown):unknown{
 if(!object(definition))return undefined;
 let value:unknown=definition.env_refs;
 if(value===undefined&&object(definition.section)&&object(definition.section.fields))value=definition.section.fields.env_refs;
 if(object(value)&&Object.hasOwn(value,'value'))value=value.value;
 if(typeof value==='string'){try{return JSON.parse(value);}catch{return value;}}
 return value;
}

/** Contract: for a bound worker session, the task's declared references that the
 * sandbox pool's profile allows (sorted, frozen; empty when none are declared).
 * Throws RUNNER_SECRET_REFERENCE_INVALID, RUNNER_SECRET_REFERENCE_UNDECLARED or
 * RUNNER_SECRET_PROFILE_UNAVAILABLE rather than dropping a reference, and
 * AGENT_LAUNCH_REFERENCES_UNBOUND when the session has no attempt or sandbox. */
export async function admissionEnvReferences(tx:Pick<PrimaryTransaction,'query'>,scope:{organisation_id:string;run_id:string;session_id:string}):Promise<LaunchEnvReferences>{
 const row=(await tx.query(`SELECT s.sandbox_id,t.definition FROM hyperfide.agent_sessions s
  JOIN hyperfide.attempts a ON a.organisation_id=s.organisation_id AND a.run_id=s.run_id AND a.id=s.attempt_id
  JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id
  WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.id=$3`,[scope.organisation_id,scope.run_id,scope.session_id])).rows[0] as {sandbox_id?:unknown;definition?:unknown}|undefined;
 if(!row||typeof row.sandbox_id!=='string')return agentError('AGENT_LAUNCH_REFERENCES_UNBOUND');
 return launchEnvReferences(tx,scope.organisation_id,row.sandbox_id,taskDefinitionEnvReferences(row.definition));
}

/** The references a stored hyperfide.native_launch_plans row carries, or undefined. */
export function storedEnvReferences(row:Record<string,unknown>):Record<string,string>|undefined{
 const refs=row.env_refs;
 if(!object(refs)||!Object.keys(refs).length)return undefined;
 return Object.fromEntries(Object.entries(refs).map(([name,ref])=>[name,String(ref)]));
}
