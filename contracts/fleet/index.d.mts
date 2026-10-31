export type KvxValue = string|number|boolean|readonly string[];
export type Sections = Readonly<Record<string, Readonly<Record<string, KvxValue>>>>;
export type NeronConfig = Sections & {
 readonly source: {readonly endpoint:string;readonly repository:string;readonly source_backend:'git'|'native';readonly revision:string;readonly auth_profile:string};
 readonly workspace: {readonly workspace_id:string;readonly workspace_generation:number;readonly environment_id:string;readonly environment_generation:number;readonly authority_epoch:string;readonly read_scope:readonly string[];readonly write_scope:readonly string[]};
 readonly cache: {readonly directory:string;readonly max_bytes:number;readonly max_entries:number;readonly security_domain:string};
 readonly client: {readonly mode:'api_only'|'sparse'|'virtual'|'materialized';readonly dirty_directory:string;readonly network_policy:'online-required'};
};
export type PackageManifest = Sections & {
 readonly environment:{readonly environment_id:string;readonly environment_generation:number;readonly platform:string;readonly image_digest:string;readonly root:string};
 readonly bootstrap:{readonly installer_path:string;readonly installer_version:string;readonly installer_sha256:string;readonly delivery:string};
 readonly source:{readonly config:string;readonly config_digest:string;readonly adapter_contract:string};
 readonly interfaces:{readonly catalogue:string;readonly catalogue_digest:string;readonly source_revision:string;readonly selected_ids:readonly string[];readonly output:string;readonly max_blocks:number;readonly max_bytes:number};
 readonly install:{readonly scope:string;readonly stages:readonly string[];readonly reuse_policy:string;readonly dirty_policy:string};
 readonly workers:{readonly slots:number;readonly source_template:string;readonly home_template:string;readonly build_template:string;readonly temporary_template:string;readonly dirty_template:string;readonly isolation:string};
 readonly readiness:{readonly require_stages:readonly string[];readonly require_probes:readonly string[];readonly receipt:string};
};
export class ContractError extends Error { readonly code: string; readonly path: string; constructor(code: string, location: string, message: string); }
export function canonical(value: unknown): string;
export function digest(value: unknown): string;
export function parseKvx(input: string, options?: {maxBytes?: number; maxSections?: number}): Sections;
export function parseNeron(input: string, options?: {allowExamples?: boolean}): NeronConfig;
export function parsePackage(input: string, options?: {neron?: NeronConfig; allowExamples?: boolean}): PackageManifest;
export function parseInterfaces(input: string, options?: {maxBytes?: number; maxBlocks?: number}): Sections;
export function scopeContains(scopes: readonly string[], candidate: string): boolean;
export const INSTALL_STAGES: readonly string[];
export const DECISION_ACTIONS: readonly string[];
export interface Decision {
 readonly schema_version: 1; readonly kind: 'hyperfide.fleet-decision'; readonly decision_id: string; readonly operation_id: string; readonly run_id: string; readonly actor_id: string; readonly actor_role: 'PRIMARY'|'WAVE_MANAGER'; readonly authority_epoch: string; readonly leader_generation: string; readonly delegation_id: string|null; readonly manager_generation: string|null; readonly source_revision: string; readonly spec_revision: string; readonly context_digest: string; readonly action: string; readonly input: Readonly<Record<string, unknown>>; readonly input_digest: string; readonly expected_version: string; readonly rationale_summary: string;
}
export interface TaskAssignment {
 readonly schema_version: 1; readonly kind: 'hyperfide.task-assignment'; readonly assignment_id: string; readonly operation_id: string; readonly decision_id: string; readonly run_id: string; readonly wave_id: string; readonly delegation_id: string; readonly manager_id: string; readonly manager_generation: string; readonly leader_generation: string; readonly authority_epoch: string; readonly environment_id: string; readonly environment_generation: number; readonly ready_receipt_digest: string; readonly source_revision: string; readonly package_digest: string; readonly source_config_digest: string; readonly worker_id: string; readonly worker_slot: number;
 readonly tasks: readonly {readonly task_id: string; readonly attempt_id: string; readonly attempt_generation: string; readonly read_scope: readonly string[]; readonly write_scope: readonly string[]; readonly required_interfaces: readonly string[]; readonly provided_interfaces: readonly string[]}[];
 readonly limits: {readonly max_runtime_seconds: number; readonly max_output_bytes: number};
}
export function validateDecision(value: unknown, options?: {actions?: readonly string[]; expected?: Record<string, unknown>}): Decision;
export function validateAssignment(value: unknown, options?: {expected?: Record<string, unknown> & {allowedTaskIds?: readonly string[]}}): TaskAssignment;
export interface InterfaceProvenance {readonly kind: 'authored'|'extracted'; readonly source_revision: string; readonly producer: string; readonly version: string; readonly input_digest: string;}
export interface InterfaceBlock {readonly kind: string; readonly path: string; readonly line: number; readonly signature: string; readonly callers: readonly string[]; readonly status: string; readonly contract: string; readonly notes: string;}
export interface InterfaceEntry {readonly id: string; readonly block: InterfaceBlock; readonly block_digest: string; readonly provenance: InterfaceProvenance; readonly references: readonly string[]; readonly proof: readonly {readonly side: 'left'|'right'; readonly digest: string}[];}
export interface InterfacePublication {readonly schema_version: 1; readonly kind: 'hyperfide.interface-publication'; readonly source_revision: string; readonly catalogue_digest: string; readonly root_digest: string; readonly entry_count: number; readonly provenance: InterfaceProvenance;}
export interface InterfaceIndex {readonly publication: InterfacePublication; readonly entries?: ReadonlyMap<string, InterfaceEntry>; readonly fetchEntry: (id: string) => Promise<InterfaceEntry|null>;}
export interface InterfaceRequest {ids: readonly string[]; sourceRevision: string; catalogueDigest: string; maxBlocks: number; maxBytes: number; expectedBlocks?: Readonly<Record<string,string>>; required?: readonly string[]; provided?: readonly string[];}
export interface InterfaceSelection {readonly schema_version: 1; readonly source_revision: string; readonly catalogue_digest: string; readonly publication_digest: string; readonly root_digest: string; readonly selected_ids: readonly string[]; readonly entries: readonly InterfaceEntry[]; readonly bytes: number; readonly coverage: 'DECLARED_CLOSURE'; readonly compatibility: 'UNVERIFIED'; readonly omitted_ids: readonly string[];}
export function createInterfaceIndex(input: {catalogue: string; sourceRevision: string; provenance: InterfaceProvenance; references?: Readonly<Record<string, readonly string[]>>}): InterfaceIndex;
export function buildInterfaceIndex(input: {chunks: AsyncIterable<string|Uint8Array>|Iterable<string|Uint8Array>; sourceRevision: string; provenance: InterfaceProvenance; references?: Readonly<Record<string, readonly string[]>>; maxBlockBytes?: number; store?: InterfaceStore}): Promise<InterfaceIndex>;
export function selectInterfaces(index: InterfaceIndex, request: InterfaceRequest): Promise<InterfaceSelection>;

export interface InterfaceStore {get(id:string):Promise<InterfaceEntry|null>;put(id:string,entry:InterfaceEntry):Promise<void>;}
export function createDirectoryInterfaceStore(directory:string):Promise<InterfaceStore>;
export interface FleetInterfaceConsumer {readonly kind:'hyperfide.fleet-interface-consumer';readonly consumer_id:string;readonly package_digest:string;readonly source_revision:string;readonly selected_ids:readonly string[];}
export interface FleetInterfaceProof {readonly schema_version:1;readonly kind:'hyperfide.fleet-interface-proof';readonly publication:InterfacePublication;readonly entries:readonly InterfaceEntry[];readonly consumer:FleetInterfaceConsumer;}
export interface FleetInterfaceExpected {publicationDigest:string;proofDigest:string;consumerId:string;packageDigest:string;sourceRevision:string;catalogueDigest:string;ids:readonly string[];maxBlocks:number;maxBytes:number;}
export function verifyFleetInterfaceSelection(input:{fragment:string;proof:unknown;expected:FleetInterfaceExpected}):Promise<InterfaceSelection & {readonly consumer:FleetInterfaceConsumer;readonly consumer_digest:string;readonly proof_digest:string;readonly fragment_digest:string}>;
