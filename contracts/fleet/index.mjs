import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile, rename, open, realpath, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class ContractError extends Error {
  constructor(code, location, message) {
    super(`${location}: ${message}`);
    this.name = 'ContractError';
    this.code = code;
    this.path = location;
  }
}
const fail = (code, location, message) => { throw new ContractError(code, location, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
function text(value, location, max = 4096) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f\p{Surrogate}]/u.test(value)) fail('INVALID_TEXT', location, 'bounded nonempty UTF-8 text required');
  return value;
}
function record(value, required, optional, location) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('SCHEMA_INVALID', location, 'fields differ from the versioned contract');
  return value;
}
function integer(value, location, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER', location, `integer ${min}..${max} required`);
  return value;
}
function member(value, choices, location) {
  if (!choices.includes(value)) fail('INVALID_VALUE', location, `expected ${choices.join(', ')}`);
  return value;
}
function identity(value, location) {
  text(value, location, 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail('INVALID_IDENTITY', location, 'canonical identity required');
  return value;
}
function generation(value, location) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_GENERATION', location, 'positive canonical bigint string required');
  return value;
}
function digestValue(value, location, allowZero = false) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value) || !allowZero && /^sha256:0{64}$/.test(value)) fail('INVALID_DIGEST', location, 'nonzero SHA-256 digest required');
  return value;
}
function sourceRevision(value, location, allowZero = false) {
  if (typeof value !== 'string' || !/^(?:git:(?:[0-9a-f]{40}|[0-9a-f]{64})|sha256:[0-9a-f]{64})$/.test(value) || !allowZero && /^(?:git|sha256):0+$/.test(value)) fail('INVALID_SOURCE_REVISION', location, 'immutable typed source revision required');
  return value;
}
function strings(value, location, { min = 0, max = 1024, validate = text } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('INVALID_ARRAY', location, `array length ${min}..${max} required`);
  value.forEach((item, index) => validate(item, `${location}[${index}]`));
  if (new Set(value).size !== value.length) fail('DUPLICATE_VALUE', location, 'duplicate entries are ambiguous');
  return value;
}
function relativePath(value, location) {
  text(value, location);
  if (path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(value)) fail('PATH_ESCAPE', location, 'normalized repository-relative path required');
  return value;
}
function absolutePath(value, location) {
  text(value, location);
  if (!value.startsWith('/') || value === '/' || value.includes('\\') || path.posix.normalize(value) !== value || value.split('/').slice(1).some(part => !part || part === '.' || part === '..')) fail('PATH_ESCAPE', location, 'normalized absolute sandbox path required');
  return value;
}
function scopePattern(value, location) {
  if (value === '**') return value;
  relativePath(value, location);
  const plainPath = value.endsWith('/**') ? value.slice(0, -3) : value;
  if (/[?*\[\]{}!]/.test(plainPath)) fail('UNSUPPORTED_SCOPE', location, 'v1 scopes support exact paths and terminal /** only');
  return value;
}
export function scopeContains(scopes, candidate) {
  scopePattern(candidate, 'candidate');
  return scopes.some(scope => {
    scopePattern(scope, 'scope');
    if (scope === '**' || scope === candidate) return true;
    if (!scope.endsWith('/**')) return false;
    const prefix = scope.slice(0, -3), other = candidate.endsWith('/**') ? candidate.slice(0, -3) : candidate;
    return other === prefix || other.startsWith(prefix + '/');
  });
}
const inside = (root, value) => value === root || value.startsWith(root + '/');
const overlaps = (a, b) => inside(a, b) || inside(b, a);
export function canonical(value) {
  const seen = new Set();
  const encode = (current, depth) => {
    if (depth > 64) fail('LIMIT_EXCEEDED', 'canonical', 'nesting limit exceeded');
    if (current === null || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'string') { if (/[\p{Surrogate}]/u.test(current)) fail('INVALID_TEXT', 'canonical', 'invalid Unicode'); return JSON.stringify(current); }
    if (typeof current === 'number') { if (!Number.isSafeInteger(current)) fail('INVALID_INTEGER', 'canonical', 'exact integers required'); return String(current); }
    if (!Array.isArray(current) && !plain(current) || seen.has(current)) fail('INVALID_VALUE', 'canonical', 'acyclic plain JSON required');
    seen.add(current);
    const result = Array.isArray(current) ? '[' + current.map(item => encode(item, depth + 1)).join(',') + ']' : '{' + Object.keys(current).sort().map(key => JSON.stringify(key) + ':' + encode(current[key], depth + 1)).join(',') + '}';
    seen.delete(current);
    return result;
  };
  return encode(value, 0);
}
export function digest(value) {
  const bytes = typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
export function parseKvx(input, options = {}) {
  const maxBytes = options.maxBytes ?? 1024 * 1024, maxSections = options.maxSections ?? 4096;
  if (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes || /[\u0000\p{Surrogate}]/u.test(input)) fail('KVX_INVALID', 'document', 'bounded valid text required');
  const sections = Object.create(null);
  let current, count = 0;
  for (const [index, original] of input.split(/\r?\n/).entries()) {
    let quoted = false, escaped = false, line = original;
    for (let i = 0; i < original.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (quoted && original[i] === '\\') { escaped = true; continue; }
      if (original[i] === '"') quoted = !quoted;
      if (!quoted && original[i] === '#') { line = original.slice(0, i); break; }
    }
    line = line.trim();
    if (!line) continue;
    const location = `line ${index + 1}`;
    const header = /^\[([A-Za-z0-9_][A-Za-z0-9_.:-]{0,254})\]$/.exec(line);
    if (header) {
      const key = header[1];
      if (Object.hasOwn(sections, key)) fail('KVX_DUPLICATE_SECTION', location, key);
      if (++count > maxSections) fail('LIMIT_EXCEEDED', location, 'section limit exceeded');
      current = Object.create(null); sections[key] = current; continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/.exec(line);
    if (!current || !assignment) fail('KVX_INVALID', location, 'section and JSON literal assignment required');
    const [, key, raw] = assignment;
    if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(current, key)) fail('KVX_DUPLICATE_KEY', location, key);
    let value;
    try { value = JSON.parse(raw); } catch { fail('KVX_INVALID', location, 'one JSON literal per line required'); }
    if (Array.isArray(value)) strings(value, location, { max: 10000 });
    else if (typeof value === 'number') integer(value, location, -Number.MAX_SAFE_INTEGER);
    else if (!['string', 'boolean'].includes(typeof value)) fail('KVX_INVALID', location, 'only strings, integers, booleans and string arrays are supported');
    if (typeof value === 'string' && /[\u0000\p{Surrogate}]/u.test(value)) fail('KVX_INVALID', location, 'invalid string encoding');
    current[key] = value;
  }
  if (!count) fail('KVX_INVALID', 'document', 'empty document');
  return freeze(sections);
}
function section(doc, name, required, optional = []) { return record(doc[name], required, optional, name); }
function meta(doc, format, options) {
  const m = section(doc, 'meta', ['format', 'schema_version'], format === 'hyperfide.sandbox-package' ? ['name', 'version', 'example'] : ['example']);
  if (m.format !== format || m.schema_version !== 1) fail('UNSUPPORTED_SCHEMA', 'meta', 'unsupported format or schema version');
  if (m.example !== undefined && typeof m.example !== 'boolean') fail('SCHEMA_INVALID', 'meta.example', 'boolean required');
  if (m.example && !options.allowExamples) fail('NON_RUNNABLE_EXAMPLE', 'meta.example', 'illustrative input cannot establish readiness');
  return Boolean(m.example && options.allowExamples);
}
function allowedSections(doc, fixed, prefixes = []) {
  for (const key of Object.keys(doc)) if (!fixed.includes(key) && !prefixes.some(prefix => new RegExp('^' + prefix + '\\.[A-Za-z][A-Za-z0-9_-]{0,63}$').test(key))) fail('UNKNOWN_SECTION', key, 'unsupported section');
}
export function parseNeron(input, options = {}) {
  const doc = parseKvx(input), example = meta(doc, 'neron.source-config', options);
  allowedSections(doc, ['meta', 'source', 'workspace', 'cache', 'client']);
  const s = section(doc, 'source', ['endpoint', 'repository', 'source_backend', 'revision', 'auth_profile']);
  let endpoint; try { endpoint = new URL(s.endpoint); } catch { fail('ENDPOINT_INVALID', 'source.endpoint', 'absolute HTTPS endpoint required'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !example && endpoint.hostname.endsWith('.invalid')) fail('ENDPOINT_INVALID', 'source.endpoint', 'nonsecret HTTPS endpoint required');
  identity(s.repository, 'source.repository'); member(s.source_backend, ['git', 'native'], 'source.source_backend'); sourceRevision(s.revision, 'source.revision', example);
  if ((s.source_backend === 'git') !== s.revision.startsWith('git:')) fail('SOURCE_MISMATCH', 'source.revision', 'backend and revision type differ');
  if (typeof s.auth_profile !== 'string' || !/^profile-ref:[A-Za-z0-9][A-Za-z0-9_.:/-]{0,239}$/.test(s.auth_profile)) fail('INVALID_REFERENCE', 'source.auth_profile', 'profile reference required');
  const w = section(doc, 'workspace', ['workspace_id', 'workspace_generation', 'environment_id', 'environment_generation', 'authority_epoch', 'read_scope', 'write_scope']);
  for (const key of ['workspace_id', 'environment_id', 'authority_epoch']) identity(w[key], 'workspace.' + key);
  integer(w.workspace_generation, 'workspace.workspace_generation'); integer(w.environment_generation, 'workspace.environment_generation');
  strings(w.read_scope, 'workspace.read_scope', { min: 1, validate: scopePattern }); strings(w.write_scope, 'workspace.write_scope', { validate: scopePattern });
  if (w.write_scope.some(scope => !scopeContains(w.read_scope, scope))) fail('SCOPE_MISMATCH', 'workspace.write_scope', 'write scope exceeds read scope');
  const c = section(doc, 'cache', ['directory', 'max_bytes', 'max_entries', 'security_domain']);
  absolutePath(c.directory, 'cache.directory'); integer(c.max_bytes, 'cache.max_bytes'); integer(c.max_entries, 'cache.max_entries'); identity(c.security_domain, 'cache.security_domain');
  const client = section(doc, 'client', ['mode', 'dirty_directory', 'network_policy']);
  member(client.mode, ['api_only', 'sparse', 'virtual', 'materialized'], 'client.mode'); absolutePath(client.dirty_directory, 'client.dirty_directory'); member(client.network_policy, ['online-required'], 'client.network_policy');
  if (overlaps(c.directory, client.dirty_directory)) fail('PATH_OVERLAP', 'client.dirty_directory', 'dirty state cannot overlap immutable cache');
  return doc;
}
export const INSTALL_STAGES = Object.freeze(['bootstrap-preflight', 'authority-resolution', 'plan-resolution', 'source-preparation', 'toolchain-preparation', 'dependency-preparation', 'configuration-preparation', 'interface-preparation', 'readiness-probes', 'ready-publication']);
export function parsePackage(input, options = {}) {
  const doc = parseKvx(input), example = meta(doc, 'hyperfide.sandbox-package', options);
  allowedSections(doc, ['meta', 'environment', 'bootstrap', 'source', 'interfaces', 'install', 'workers', 'readiness'], ['mount', 'toolchain', 'dependency', 'configuration', 'probe']);
  text(doc.meta.name, 'meta.name', 128); text(doc.meta.version, 'meta.version', 128);
  const env = section(doc, 'environment', ['environment_id', 'environment_generation', 'platform', 'image_digest', 'root']);
  identity(env.environment_id, 'environment.environment_id'); integer(env.environment_generation, 'environment.environment_generation'); member(env.platform, ['linux-amd64', 'linux-arm64'], 'environment.platform'); digestValue(env.image_digest, 'environment.image_digest', example); absolutePath(env.root, 'environment.root');
  const bootstrap = section(doc, 'bootstrap', ['installer_path', 'installer_version', 'installer_sha256', 'delivery']);
  absolutePath(bootstrap.installer_path, 'bootstrap.installer_path'); text(bootstrap.installer_version, 'bootstrap.installer_version', 128); digestValue(bootstrap.installer_sha256, 'bootstrap.installer_sha256', example); member(bootstrap.delivery, ['image', 'coordinator-artifact'], 'bootstrap.delivery');
  const source = section(doc, 'source', ['config', 'config_digest', 'adapter_contract']);
  relativePath(source.config, 'source.config'); digestValue(source.config_digest, 'source.config_digest', example); member(source.adapter_contract, ['source-manifest-v1'], 'source.adapter_contract');
  const neron = options.neron;
  if (neron) {
    if (!example && source.config_digest !== digest(neron)) fail('SOURCE_MISMATCH', 'source.config_digest', 'source configuration digest differs');
    if (env.environment_id !== neron.workspace.environment_id || env.environment_generation !== neron.workspace.environment_generation) fail('ENVIRONMENT_MISMATCH', 'environment', 'source and package environment identities differ');
  }
  const targets = [], mountNames = new Set(), toolchains = new Map(), probeNames = new Set();
  const underRoot = (value, location) => { absolutePath(value, location); if (!inside(env.root, value) || value === env.root) fail('PATH_ESCAPE', location, 'path must be below environment root'); };
  for (const [name, value] of Object.entries(doc)) {
    if (name.startsWith('mount.')) {
      record(value, ['kind', 'source', 'paths', 'target', 'access', 'mode'], [], name); member(value.kind, ['source'], name + '.kind'); member(value.source, ['primary'], name + '.source');
      strings(value.paths, name + '.paths', { min: 1, validate: scopePattern }); underRoot(value.target, name + '.target'); member(value.access, ['read_only', 'private_overlay'], name + '.access'); member(value.mode, ['sparse', 'virtual', 'materialized'], name + '.mode');
      if (targets.some(target => overlaps(target, value.target))) fail('PATH_OVERLAP', name + '.target', 'mount targets overlap');
      if (neron && value.paths.some(scope => !scopeContains(neron.workspace.read_scope, scope))) fail('SCOPE_MISMATCH', name + '.paths', 'mount exceeds requested source read scope');
      targets.push(value.target); mountNames.add(name.slice(6));
    }
    if (name.startsWith('toolchain.')) {
      record(value, ['kind', 'version', 'delivery', 'artifact_digest', 'executable'], [], name); identity(value.kind, name + '.kind'); text(value.version, name + '.version', 128); member(value.delivery, ['image', 'coordinator-artifact'], name + '.delivery'); digestValue(value.artifact_digest, name + '.artifact_digest', example); absolutePath(value.executable, name + '.executable'); toolchains.set(value.kind, value);
    }
    if (name.startsWith('probe.')) {
      record(value, ['argv', 'cwd', 'timeout_seconds', 'expected_exit'], [], name); strings(value.argv, name + '.argv', { min: 1, max: 256 }); absolutePath(value.argv[0], name + '.argv[0]'); underRoot(value.cwd, name + '.cwd'); integer(value.timeout_seconds, name + '.timeout_seconds', 1, 86400); integer(value.expected_exit, name + '.expected_exit', 0, 255); probeNames.add(name.slice(6));
    }
    if (name.startsWith('configuration.')) {
      record(value, ['kind', 'reference', 'target', 'mode', 'required'], [], name); member(value.kind, ['config-ref', 'secret-ref'], name + '.kind'); text(value.reference, name + '.reference', 255);
      if (!value.reference.startsWith(value.kind + ':') || !/^(?:config-ref|secret-ref):[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value.reference)) fail('INVALID_REFERENCE', name + '.reference', 'typed configuration reference required');
      underRoot(value.target, name + '.target'); if (!/^0[0-7]{3}$/.test(value.mode) || typeof value.required !== 'boolean') fail('SCHEMA_INVALID', name, 'octal mode and required boolean expected');
      if (value.kind === 'secret-ref' && (parseInt(value.mode, 8) & 0o077)) fail('SECRET_MODE_INVALID', name + '.mode', 'secret configuration must be owner-only');
    }
  }
  for (const [name, value] of Object.entries(doc)) if (name.startsWith('dependency.')) {
    record(value, ['manager', 'version', 'mount', 'lockfile', 'lockfile_digest', 'include', 'argv', 'script_policy'], [], name);
    identity(value.manager, name + '.manager'); text(value.version, name + '.version', 128); if (!mountNames.has(value.mount)) fail('MISSING_REFERENCE', name + '.mount', 'unknown source mount');
    relativePath(value.lockfile, name + '.lockfile'); digestValue(value.lockfile_digest, name + '.lockfile_digest', example); strings(value.include, name + '.include', { min: 1 }); strings(value.argv, name + '.argv', { min: 1, max: 256 }); absolutePath(value.argv[0], name + '.argv[0]'); member(value.script_policy, ['deny', 'approved-plan'], name + '.script_policy');
    const tool = toolchains.get(value.manager); if (!tool || tool.version !== value.version || tool.executable !== value.argv[0]) fail('DEPENDENCY_DRIFT', name, 'manager version/executable lacks matching toolchain pin');
    if (value.argv.some(arg => arg === '--no-frozen-lockfile' || arg === '--force')) fail('DEPENDENCY_DRIFT', name + '.argv', 'lockfile bypass is unsupported');
  }
  const interfaces = section(doc, 'interfaces', ['catalogue', 'catalogue_digest', 'source_revision', 'selected_ids', 'output', 'max_blocks', 'max_bytes']);
  relativePath(interfaces.catalogue, 'interfaces.catalogue'); digestValue(interfaces.catalogue_digest, 'interfaces.catalogue_digest', example); sourceRevision(interfaces.source_revision, 'interfaces.source_revision', example); strings(interfaces.selected_ids, 'interfaces.selected_ids', { max: 4096, validate: interfaceId }); underRoot(interfaces.output, 'interfaces.output'); integer(interfaces.max_blocks, 'interfaces.max_blocks', 1, 4096); integer(interfaces.max_bytes, 'interfaces.max_bytes', 1, 16 * 1024 * 1024);
  if (interfaces.selected_ids.length > interfaces.max_blocks) fail('LIMIT_EXCEEDED', 'interfaces.selected_ids', 'selection exceeds block bound');
  if (neron && interfaces.source_revision !== neron.source.revision) fail('SOURCE_MISMATCH', 'interfaces.source_revision', 'interface and code source differ');
  const install = section(doc, 'install', ['scope', 'stages', 'reuse_policy', 'dirty_policy']);
  member(install.scope, ['environment_generation'], 'install.scope'); if (canonical(install.stages) !== canonical(INSTALL_STAGES)) fail('INSTALL_ORDER_INVALID', 'install.stages', 'v1 stage order is fixed'); member(install.reuse_policy, ['exact-input-clean'], 'install.reuse_policy'); member(install.dirty_policy, ['refuse-overwrite'], 'install.dirty_policy');
  const workers = section(doc, 'workers', ['slots', 'source_template', 'home_template', 'build_template', 'temporary_template', 'dirty_template', 'isolation']); integer(workers.slots, 'workers.slots', 1, 1024); member(workers.isolation, ['private-overlay'], 'workers.isolation');
  const roots = [];
  for (const key of ['source_template', 'home_template', 'build_template', 'temporary_template', 'dirty_template']) {
    const value = text(workers[key], 'workers.' + key); if (value.split('{slot}').length !== 2 || /[{}]/.test(value.replace('{slot}', '1'))) fail('PATH_TEMPLATE_INVALID', 'workers.' + key, 'one {slot} placeholder required');
    const expanded = value.replace('{slot}', '1'); underRoot(expanded, 'workers.' + key); if (roots.some(root => overlaps(root, expanded)) || targets.some(target => overlaps(target, expanded))) fail('PATH_OVERLAP', 'workers.' + key, 'worker writable roots overlap'); roots.push(expanded);
  }
  for (const [name, value] of Object.entries(doc)) if (name.startsWith('configuration.')) {
    const privateConfig = value.kind === 'secret-ref' || value.mode !== '0444';
    if (privateConfig) {
      if ((parseInt(value.mode, 8) & 0o077) || value.target.split('{slot}').length !== 2 || /[{}]/.test(value.target.replace('{slot}', '0'))) fail('CONFIGURATION_TARGET_INVALID', name, 'private configuration requires owner-only mode and one {slot} placeholder');
      for (let slot = 0; slot < workers.slots; slot++) {
        const home = workers.home_template.replace('{slot}', String(slot)), target = value.target.replace('{slot}', String(slot));
        if (!target.startsWith(home + '/')) fail('CONFIGURATION_TARGET_INVALID', name, 'private configuration target must be beneath its worker home');
      }
    } else if (/[{}]/.test(value.target)) fail('CONFIGURATION_TARGET_INVALID', name, 'shared readonly configuration target cannot be a template');
  }
  const ready = section(doc, 'readiness', ['require_stages', 'require_probes', 'receipt']); strings(ready.require_stages, 'readiness.require_stages', { min: 1 }); strings(ready.require_probes, 'readiness.require_probes');
  if (canonical(ready.require_stages) !== canonical(INSTALL_STAGES.slice(0, -1))) fail('READINESS_INVALID', 'readiness.require_stages', 'all pre-publication stages required');
  if (ready.require_probes.some(name => !probeNames.has(name)) || [...probeNames].some(name => !ready.require_probes.includes(name))) fail('READINESS_INVALID', 'readiness.require_probes', 'every declared probe must be required'); underRoot(ready.receipt, 'readiness.receipt');
  return doc;
}
export const DECISION_ACTIONS = Object.freeze(['CONFIGURE_WAVE', 'DELEGATE_WAVE', 'REPLACE_MANAGER', 'PROVISION_SANDBOX', 'REUSE_SANDBOX', 'ASSIGN_WORKER', 'STEER_WORKER', 'CANCEL_ASSIGNMENT', 'STOP_SANDBOX', 'DESTROY_SANDBOX', 'REPLAN', 'COORDINATE_DEPENDENCY', 'fleet.install.admit', 'fleet.install.adopt']);
export function validateDecision(value, options = {}) {
  record(value, ['schema_version', 'kind', 'decision_id', 'operation_id', 'run_id', 'actor_id', 'actor_role', 'authority_epoch', 'leader_generation', 'delegation_id', 'manager_generation', 'source_revision', 'spec_revision', 'context_digest', 'action', 'input', 'input_digest', 'expected_version', 'rationale_summary'], [], 'decision');
  if (value.schema_version !== 1 || value.kind !== 'hyperfide.fleet-decision') fail('UNSUPPORTED_SCHEMA', 'decision', 'fleet decision v1 required');
  for (const key of ['decision_id', 'operation_id', 'run_id', 'actor_id', 'authority_epoch', 'spec_revision']) identity(value[key], 'decision.' + key);
  member(value.actor_role, ['PRIMARY', 'WAVE_MANAGER'], 'decision.actor_role'); generation(value.leader_generation, 'decision.leader_generation'); if (value.expected_version !== '0') generation(value.expected_version, 'decision.expected_version');
  if (value.actor_role === 'WAVE_MANAGER') { identity(value.delegation_id, 'decision.delegation_id'); generation(value.manager_generation, 'decision.manager_generation'); }
  else if (value.delegation_id !== null || value.manager_generation !== null) fail('IDENTITY_MISMATCH', 'decision', 'Primary decision cannot claim manager ownership');
  sourceRevision(value.source_revision, 'decision.source_revision'); digestValue(value.context_digest, 'decision.context_digest'); digestValue(value.input_digest, 'decision.input_digest'); member(value.action, options.actions ?? DECISION_ACTIONS, 'decision.action');
  if (!plain(value.input) || Buffer.byteLength(canonical(value.input)) > 256 * 1024) fail('LIMIT_EXCEEDED', 'decision.input', 'bounded typed action object required');
  if (digest(value.input) !== value.input_digest) fail('DIGEST_MISMATCH', 'decision.input_digest', 'input digest differs'); text(value.rationale_summary, 'decision.rationale_summary', 4096);
  validateBindings(value, options.expected, 'decision');
  return freeze(JSON.parse(canonical(value)));
}
function validateBindings(value, expected, location) {
  if (!expected) return;
  if (!plain(expected)) fail('SCHEMA_INVALID', location + '.expected', 'binding object required');
  for (const [key, required] of Object.entries(expected)) {
    if (key === 'allowedTaskIds') continue;
    if (!Object.hasOwn(value, key) || canonical(value[key]) !== canonical(required)) fail('BINDING_MISMATCH', location + '.' + key, 'current authenticated binding differs');
  }
}
export function validateAssignment(value, options = {}) {
  record(value, ['schema_version', 'kind', 'assignment_id', 'operation_id', 'decision_id', 'run_id', 'wave_id', 'delegation_id', 'manager_id', 'manager_generation', 'leader_generation', 'authority_epoch', 'environment_id', 'environment_generation', 'ready_receipt_digest', 'source_revision', 'package_digest', 'source_config_digest', 'worker_id', 'worker_slot', 'tasks', 'limits', ...(value?.schema_version === 2 ? ['source'] : [])], [], 'assignment');
  if (![1, 2].includes(value.schema_version) || value.kind !== 'hyperfide.task-assignment') fail('UNSUPPORTED_SCHEMA', 'assignment', 'task assignment v1 or native v2 required');
  for (const key of ['assignment_id', 'operation_id', 'decision_id', 'run_id', 'wave_id', 'delegation_id', 'manager_id', 'authority_epoch', 'environment_id', 'worker_id']) identity(value[key], 'assignment.' + key);
  generation(value.manager_generation, 'assignment.manager_generation'); generation(value.leader_generation, 'assignment.leader_generation'); integer(value.environment_generation, 'assignment.environment_generation'); integer(value.worker_slot, 'assignment.worker_slot', 0, 1023);
  for (const key of ['ready_receipt_digest', 'package_digest', 'source_config_digest']) digestValue(value[key], 'assignment.' + key);
  sourceRevision(value.source_revision, 'assignment.source_revision');
  if (value.schema_version === 2) {
    record(value.source, ['source_backend', 'scope', 'revision_id', 'root_tree_id', 'source_manifest_digest', 'workspace_id', 'workspace_generation', 'bootstrap_workspace_id'], [], 'assignment.source');
    member(value.source.source_backend, ['native'], 'assignment.source.source_backend');
    record(value.source.scope, ['organisation_id', 'repository_id', 'security_domain_id'], [], 'assignment.source.scope');
    for (const [key, item] of Object.entries(value.source.scope)) if (typeof item !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)) fail('INVALID_IDENTITY', 'assignment.source.scope.' + key, 'scoped native UUID required');
    for (const key of ['revision_id', 'root_tree_id', 'source_manifest_digest']) digestValue(value.source[key], 'assignment.source.' + key);
    identity(value.source.workspace_id, 'assignment.source.workspace_id');
    identity(value.source.bootstrap_workspace_id, 'assignment.source.bootstrap_workspace_id');
    generation(value.source.workspace_generation, 'assignment.source.workspace_generation');
    if (value.source.revision_id !== value.source_revision) fail('SOURCE_MISMATCH', 'assignment.source.revision_id', 'native assignment revision differs');
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 128) fail('LIMIT_EXCEEDED', 'assignment.tasks', 'one to 128 individually tracked tasks required');
  const tasks = new Set(), attempts = new Set();
  for (const [index, task] of value.tasks.entries()) {
    const location = `assignment.tasks[${index}]`;
    record(task, ['task_id', 'attempt_id', 'attempt_generation', 'read_scope', 'write_scope', 'required_interfaces', 'provided_interfaces'], [], location);
    identity(task.task_id, location + '.task_id'); identity(task.attempt_id, location + '.attempt_id'); generation(task.attempt_generation, location + '.attempt_generation');
    if (tasks.has(task.task_id) || attempts.has(task.attempt_id)) fail('DUPLICATE_IDENTITY', location, 'task/attempt identities must be distinct'); tasks.add(task.task_id); attempts.add(task.attempt_id);
    strings(task.read_scope, location + '.read_scope', { min: 1, validate: scopePattern }); strings(task.write_scope, location + '.write_scope', { validate: scopePattern });
    if (task.write_scope.some(scope => !scopeContains(task.read_scope, scope))) fail('SCOPE_MISMATCH', location + '.write_scope', 'write scope exceeds read scope');
    strings(task.required_interfaces, location + '.required_interfaces', { validate: interfaceId }); strings(task.provided_interfaces, location + '.provided_interfaces', { validate: interfaceId });
    if (options.expected?.allowedTaskIds && !options.expected.allowedTaskIds.includes(task.task_id)) fail('BINDING_MISMATCH', location + '.task_id', 'task is outside current delegation');
  }
  record(value.limits, ['max_runtime_seconds', 'max_output_bytes'], [], 'assignment.limits'); integer(value.limits.max_runtime_seconds, 'assignment.limits.max_runtime_seconds', 1, 7 * 86400); integer(value.limits.max_output_bytes, 'assignment.limits.max_output_bytes');
  validateBindings(value, options.expected, 'assignment');
  return freeze(JSON.parse(canonical(value)));
}
function interfaceId(value, location) {
  text(value, location, 255);
  if (!/^interface\.[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail('INVALID_INTERFACE_ID', location, 'stable interface.<id> required');
  return value;
}
function interfaceBlock(id, value) {
  interfaceId(id, 'interface.id'); record(value, ['kind', 'path', 'line', 'signature', 'callers', 'status', 'contract', 'notes'], [], id);
  identity(value.kind, id + '.kind'); relativePath(value.path, id + '.path'); integer(value.line, id + '.line'); identity(value.status, id + '.status');
  for (const key of ['signature', 'contract', 'notes']) if (typeof value[key] !== 'string' || Buffer.byteLength(value[key]) > 256 * 1024 || /[\u0000\p{Surrogate}]/u.test(value[key])) fail('INTERFACE_INVALID', id + '.' + key, 'bounded text required');
  strings(value.callers, id + '.callers', { max: 10000, validate: relativePath });
  return value;
}
function provenance(value, revision) {
  record(value, ['kind', 'source_revision', 'producer', 'version', 'input_digest'], [], 'provenance');
  member(value.kind, ['authored', 'extracted'], 'provenance.kind'); sourceRevision(value.source_revision, 'provenance.source_revision'); identity(value.producer, 'provenance.producer'); text(value.version, 'provenance.version', 128); digestValue(value.input_digest, 'provenance.input_digest');
  if (value.source_revision !== revision) fail('SOURCE_MISMATCH', 'provenance.source_revision', 'provenance source differs from publication');
}
const leafDigest = entry => digest({ kind: 'hyperfide.interface-leaf.v1', id: entry.id, block_digest: entry.block_digest, provenance: entry.provenance, references: entry.references });
const parentDigest = (left, right) => digest({ kind: 'hyperfide.interface-node.v1', left, right });
function buildIndex(blocks, source, catalogueDigest, origin, references = {}) {
  sourceRevision(source, 'sourceRevision'); provenance(origin, source); digestValue(catalogueDigest, 'catalogueDigest');
  const ordered = [...blocks].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!ordered.length) fail('INTERFACE_INVALID', 'catalogue', 'at least one interface required');
  const entries = new Map(ordered.map(([id, block]) => {
    interfaceBlock(id, block); const refs = references[id] ?? []; strings(refs, id + '.references', { max: 1024, validate: interfaceId });
    return [id, { id, block, block_digest: digest(block), provenance: origin, references: refs, proof: [] }];
  }));
  let nodes = [...entries.values()].map(entry => ({ digest: leafDigest(entry), ids: [entry.id] }));
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i], right = nodes[i + 1] ?? nodes[i];
      for (const id of left.ids) entries.get(id).proof.push({ side: 'right', digest: right.digest });
      if (nodes[i + 1]) for (const id of right.ids) entries.get(id).proof.push({ side: 'left', digest: left.digest });
      next.push({ digest: parentDigest(left.digest, right.digest), ids: nodes[i + 1] ? [...left.ids, ...right.ids] : left.ids });
    }
    nodes = next;
  }
  const publication = freeze({ schema_version: 1, kind: 'hyperfide.interface-publication', source_revision: source, catalogue_digest: catalogueDigest, root_digest: nodes[0].digest, entry_count: entries.size, provenance: origin });
  for (const entry of entries.values()) freeze(entry);
  return { publication, entries, fetchEntry: async id => entries.get(id) ?? null };
}
export function parseInterfaces(input, options = {}) {
  const blocks = parseKvx(input, { maxBytes: options.maxBytes ?? 1024 * 1024, maxSections: options.maxBlocks ?? 4096 });
  for (const [id, block] of Object.entries(blocks)) interfaceBlock(id, block);
  return blocks;
}
export function createInterfaceIndex({ catalogue, sourceRevision: source, provenance: origin, references = {} }) {
  const blocks = Object.entries(parseKvx(catalogue, { maxBytes: 8 * 1024 * 1024, maxSections: 100000 }));
  return buildIndex(blocks, source, digest(catalogue), origin, references);
}
export async function createDirectoryInterfaceStore(directory) {
  absolutePath(directory, 'index.directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owned = stat => !(stat.mode & 0o077) && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  const initial = await lstat(directory), canonicalRoot = await realpath(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink() || !owned(initial)) fail('PATH_ESCAPE', 'index.directory', 'ordinary owned private directory required');
  const sameDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) && stat.dev === initial.dev && stat.ino === initial.ino;
  const anchored = async body => {
    let handle;
    try {
      if (!sameDirectory(await lstat(canonicalRoot))) fail('PATH_ESCAPE', 'index.directory', 'private index directory identity changed');
      let root = canonicalRoot;
      if (process.platform === 'linux') {
        handle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!sameDirectory(await handle.stat())) fail('PATH_ESCAPE', 'index.directory', 'private index directory identity changed');
        const descriptorRoot = '/proc/self/fd/' + handle.fd;
        try {
          if (await realpath(descriptorRoot) !== canonicalRoot) fail('PATH_ESCAPE', 'index.directory', 'private index directory identity changed');
          root = descriptorRoot;
        } catch (error) {
          if (!['ENOENT','EACCES','EPERM','ERR_ACCESS_DENIED'].includes(error?.code)) throw error;
          await handle.close(); handle = undefined;
        }
      }
      const result = await body(root);
      if (!sameDirectory(await lstat(canonicalRoot)) || await realpath(canonicalRoot) !== canonicalRoot) fail('PATH_ESCAPE', 'index.directory', 'private index directory identity changed');
      return result;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (['ELOOP','ENOTDIR'].includes(error?.code)) fail('PATH_ESCAPE', 'index.directory', 'index directory cannot be a link');
      fail('INTERFACE_INVALID', 'index.directory', 'protected index storage unavailable');
    } finally { await handle?.close(); }
  };
  await anchored(async () => {});
  const filename = id => digest(interfaceId(id, 'interface.id')).slice(7) + '.json';
  return {
    async get(id) {
      const name = filename(id);
      return anchored(async root => {
        let file;
        try {
          const target = path.join(root, name), before = await lstat(target);
          if (!before.isFile() || before.isSymbolicLink()) fail('INTERFACE_INVALID', id, 'ordinary index record required');
          file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const stat = await file.stat();
          if (stat.dev !== before.dev || stat.ino !== before.ino) fail('INTERFACE_INVALID', id, 'index record identity changed');
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('INTERFACE_INVALID', id, 'bounded ordinary index record required');
          const buffer = Buffer.alloc(stat.size + 1); let length = 0;
          while (length < buffer.length) { const {bytesRead} = await file.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
          const after = await file.stat();
          if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('INTERFACE_INVALID', id, 'index record changed during read');
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
          catch { fail('INTERFACE_INVALID', id, 'invalid indexed JSON record'); }
        } catch (error) {
          if (error?.code === 'ENOENT') return null;
          if (error instanceof ContractError) throw error;
          fail('INTERFACE_INVALID', id, 'protected index record unavailable');
        } finally { await file?.close(); }
      });
    },
    async put(id, entry) {
      const name = filename(id), bytes = canonical(entry);
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) fail('LIMIT_EXCEEDED', id, 'index record exceeds byte bound');
      await anchored(async root => {
        const target = path.join(root, name), temporary = target + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
          await rename(temporary, target);
        } finally { await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error; }); }
      });
    },
  };
}

export async function buildInterfaceIndex({ chunks, sourceRevision: source, provenance: origin, references = {}, maxBlockBytes = 1024 * 1024, store }) {
  sourceRevision(source, 'sourceRevision'); provenance(origin, source); integer(maxBlockBytes, 'maxBlockBytes', 1, 1024 * 1024);
  const memory = new Map(), external = Boolean(store);
  const sink = store ?? { get: async id => memory.get(id) ?? null, put: async (id, entry) => { memory.set(id, entry); } };
  if (typeof sink.get !== 'function' || typeof sink.put !== 'function') fail('INTERFACE_INVALID', 'store', 'indexed get/put store required');
  const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true }), leaves = new Map();
  let pending = '', block = '', id = null, total = 0;
  const finish = async () => {
    if (id === null) return;
    const parsed = parseKvx(block, { maxBytes: maxBlockBytes, maxSections: 1 });
    if (leaves.has(id)) fail('KVX_DUPLICATE_SECTION', id, 'duplicate catalogue ID');
    interfaceBlock(id, parsed[id]);
    const refs = references[id] ?? []; strings(refs, id + '.references', { max: 1024, validate: interfaceId });
    const entry = { id, block: parsed[id], block_digest: digest(parsed[id]), provenance: origin, references: refs, proof: [] };
    leaves.set(id, { digest: leafDigest(entry), proof: [] }); await sink.put(id, entry);
  };
  const line = async raw => {
    const header = /^\s*\[(interface\.[A-Za-z0-9_.:-]+)\]\s*(?:#.*)?$/.exec(raw);
    if (header) { await finish(); id = header[1]; block = ''; }
    if (id !== null) { block += raw + '\n'; if (Buffer.byteLength(block) > maxBlockBytes) fail('LIMIT_EXCEEDED', id, 'interface block exceeds bound'); }
    else if (raw.trim() && !raw.trim().startsWith('#')) fail('INTERFACE_INVALID', 'catalogue', 'unexpected preamble');
  };
  try {
    for await (const chunk of chunks) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (!(bytes instanceof Uint8Array)) fail('INTERFACE_INVALID', 'chunks', 'byte chunks required');
      total += bytes.byteLength;
      if (!external && total > 8 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'catalogue', 'large catalogue requires external indexed store');
      hash.update(bytes); pending += decoder.decode(bytes, { stream: true });
      let end; while ((end = pending.indexOf('\n')) !== -1) { await line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1); }
      if (Buffer.byteLength(pending) > maxBlockBytes) fail('LIMIT_EXCEEDED', 'catalogue', 'line exceeds block bound');
    }
    pending += decoder.decode();
  } catch (error) { if (error instanceof ContractError) throw error; fail('INTERFACE_INVALID', 'catalogue', 'invalid UTF-8 stream or index storage failure'); }
  if (pending) await line(pending.replace(/\r$/, '')); await finish();
  if (!leaves.size) fail('INTERFACE_INVALID', 'catalogue', 'at least one interface required');
  let nodes = [...leaves].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ digest: value.digest, ids: [key] }));
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i], right = nodes[i + 1] ?? nodes[i];
      for (const key of left.ids) leaves.get(key).proof.push({ side: 'right', digest: right.digest });
      if (nodes[i + 1]) for (const key of right.ids) leaves.get(key).proof.push({ side: 'left', digest: left.digest });
      next.push({ digest: parentDigest(left.digest, right.digest), ids: nodes[i + 1] ? [...left.ids, ...right.ids] : left.ids });
    }
    nodes = next;
  }
  for (const [key, value] of leaves) { const entry = await sink.get(key); if (!entry || leafDigest(entry) !== value.digest) fail('INTERFACE_TAMPERED', key, 'index staging changed'); await sink.put(key, { ...entry, proof: value.proof }); }
  const publication = freeze({ schema_version: 1, kind: 'hyperfide.interface-publication', source_revision: source, catalogue_digest: 'sha256:' + hash.digest('hex'), root_digest: nodes[0].digest, entry_count: leaves.size, provenance: origin });
  return { publication, ...(external ? {} : { entries: memory }), fetchEntry: async key => sink.get(key) };
}

function publication(value) {
  record(value, ['schema_version', 'kind', 'source_revision', 'catalogue_digest', 'root_digest', 'entry_count', 'provenance'], [], 'publication');
  if (value.schema_version !== 1 || value.kind !== 'hyperfide.interface-publication') fail('UNSUPPORTED_SCHEMA', 'publication', 'interface publication v1 required');
  sourceRevision(value.source_revision, 'publication.source_revision'); digestValue(value.catalogue_digest, 'publication.catalogue_digest'); digestValue(value.root_digest, 'publication.root_digest'); integer(value.entry_count, 'publication.entry_count'); provenance(value.provenance, value.source_revision);
}
function verifyEntry(entry, pub) {
  record(entry, ['id', 'block', 'block_digest', 'provenance', 'references', 'proof'], [], 'interface-entry'); interfaceBlock(entry.id, entry.block); digestValue(entry.block_digest, 'interface-entry.block_digest'); provenance(entry.provenance, pub.source_revision); strings(entry.references, 'interface-entry.references', { max: 1024, validate: interfaceId });
  if (digest(entry.block) !== entry.block_digest || canonical(entry.provenance) !== canonical(pub.provenance)) fail('INTERFACE_TAMPERED', entry.id, 'block or provenance differs');
  if (!Array.isArray(entry.proof) || entry.proof.length > 64 || entry.proof.length !== Math.ceil(Math.log2(pub.entry_count))) fail('INTERFACE_TAMPERED', entry.id, 'invalid membership proof length');
  let root = leafDigest(entry);
  for (const step of entry.proof) { record(step, ['side', 'digest'], [], entry.id + '.proof'); member(step.side, ['left', 'right'], entry.id + '.proof.side'); digestValue(step.digest, entry.id + '.proof.digest'); root = step.side === 'left' ? parentDigest(step.digest, root) : parentDigest(root, step.digest); }
  if (root !== pub.root_digest) fail('INTERFACE_TAMPERED', entry.id, 'entry is outside pinned publication');
}
export async function selectInterfaces(index, request) {
  const pub = index.publication; publication(pub);
  record(request, ['ids', 'sourceRevision', 'catalogueDigest', 'maxBlocks', 'maxBytes'], ['expectedBlocks', 'required', 'provided'], 'selection');
  strings(request.ids, 'selection.ids', { max: 4096, validate: interfaceId }); integer(request.maxBlocks, 'selection.maxBlocks', 1, 4096); integer(request.maxBytes, 'selection.maxBytes', 1, 16 * 1024 * 1024);
  if (request.sourceRevision !== pub.source_revision || request.catalogueDigest !== pub.catalogue_digest) fail('SOURCE_MISMATCH', 'selection', 'publication does not match pinned source/catalogue');
  if (typeof index.fetchEntry !== 'function') fail('INTERFACE_INVALID', 'index', 'indexed entry reader required');
  for (const key of ['required', 'provided']) if (request[key] !== undefined) strings(request[key], 'selection.' + key, { max: 4096, validate: interfaceId });
  if (request.expectedBlocks !== undefined) {
    if (!plain(request.expectedBlocks)) fail('INTERFACE_INVALID', 'selection.expectedBlocks', 'expected block map required');
    for (const [id, value] of Object.entries(request.expectedBlocks)) { interfaceId(id, 'selection.expectedBlocks'); digestValue(value, 'selection.expectedBlocks.' + id); }
  }
  const queue = [...request.ids], seen = new Set(), entries = []; let bytes = 0;
  while (queue.length) {
    const id = queue.shift(); if (seen.has(id)) continue;
    if (seen.size >= request.maxBlocks) fail('LIMIT_EXCEEDED', 'selection', 'selected closure exceeds block bound');
    const entry = await index.fetchEntry(id);
    if (!entry || entry.id !== id) fail('MISSING_INTERFACE', id, 'selected interface missing'); verifyEntry(entry, pub);
    bytes += Buffer.byteLength(canonical(entry)); if (bytes > request.maxBytes) fail('LIMIT_EXCEEDED', 'selection', 'selected closure exceeds byte bound');
    if (request.expectedBlocks && Object.hasOwn(request.expectedBlocks, id) && request.expectedBlocks[id] !== entry.block_digest) fail('STALE_INTERFACE', id, 'consumer expects another block revision');
    seen.add(id); entries.push(entry); queue.push(...entry.references);
  }
  for (const id of [...(request.required ?? []), ...(request.provided ?? [])]) { interfaceId(id, 'selection.obligation'); if (!seen.has(id)) fail('MISSING_INTERFACE', id, 'declared interface obligation not selected'); }
  return freeze({ schema_version: 1, source_revision: pub.source_revision, catalogue_digest: pub.catalogue_digest, publication_digest: digest(pub), root_digest: pub.root_digest, selected_ids: [...seen], entries, bytes, coverage: 'DECLARED_CLOSURE', compatibility: 'UNVERIFIED', omitted_ids: [] });
}

export async function verifyFleetInterfaceSelection({ fragment, proof, expected }) {
  record(expected, ['publicationDigest', 'proofDigest', 'consumerId', 'packageDigest', 'sourceRevision', 'catalogueDigest', 'ids', 'maxBlocks', 'maxBytes'], [], 'fleet-interface.expected');
  for (const key of ['publicationDigest', 'proofDigest', 'packageDigest', 'catalogueDigest']) digestValue(expected[key], 'fleet-interface.expected.' + key);
  identity(expected.consumerId, 'fleet-interface.expected.consumerId');
  record(proof, ['schema_version', 'kind', 'publication', 'entries', 'consumer'], [], 'fleet-interface.proof');
  if (proof.schema_version !== 1 || proof.kind !== 'hyperfide.fleet-interface-proof') fail('UNSUPPORTED_SCHEMA', 'fleet-interface.proof', 'fleet interface proof v1 required');
  if (digest(proof) !== expected.proofDigest || digest(proof.publication) !== expected.publicationDigest) fail('INTERFACE_TAMPERED', 'fleet-interface.proof', 'proof or publication differs from registered pin');
  const consumer = proof.consumer;
  record(consumer, ['kind', 'consumer_id', 'package_digest', 'source_revision', 'selected_ids'], [], 'fleet-interface.consumer');
  if (consumer.kind !== 'hyperfide.fleet-interface-consumer' || consumer.consumer_id !== expected.consumerId || consumer.package_digest !== expected.packageDigest || consumer.source_revision !== expected.sourceRevision || canonical(consumer.selected_ids) !== canonical(expected.ids)) fail('INTERFACE_CONSUMER_MISMATCH', 'fleet-interface.consumer', 'consumer identity, package, source or selection differs');
  integer(expected.maxBlocks, 'fleet-interface.maxBlocks', 1, 4096); integer(expected.maxBytes, 'fleet-interface.maxBytes', 1, 16 * 1024 * 1024);
  if (!Array.isArray(proof.entries) || proof.entries.length > expected.maxBlocks || Buffer.byteLength(canonical(proof)) > expected.maxBytes) fail('LIMIT_EXCEEDED', 'fleet-interface.proof', 'bounded indexed proof required');
  const entries = new Map();
  for (const entry of proof.entries) {
    if (!plain(entry) || typeof entry.id !== 'string' || entries.has(entry.id)) fail('INTERFACE_TAMPERED', 'fleet-interface.entries', 'unique indexed entries required');
    entries.set(entry.id, entry);
  }
  const selected = await selectInterfaces({ publication: proof.publication, fetchEntry: async id => entries.get(id) ?? null }, { ids: expected.ids, sourceRevision: expected.sourceRevision, catalogueDigest: expected.catalogueDigest, maxBlocks: expected.maxBlocks, maxBytes: expected.maxBytes });
  if (selected.entries.length !== entries.size || canonical([...selected.selected_ids].sort()) !== canonical([...expected.ids].sort())) fail('INTERFACE_SELECTION_MISMATCH', 'fleet-interface.entries', 'exact selected closure required');
  if (typeof fragment !== 'string') fail('INTERFACE_INVALID', 'fleet-interface.fragment', 'UTF-8 fragment text required');
  const blocks = parseInterfaces(fragment, { maxBytes: expected.maxBytes, maxBlocks: expected.maxBlocks });
  if (canonical(Object.keys(blocks).sort()) !== canonical([...selected.selected_ids].sort())) fail('INTERFACE_SELECTION_MISMATCH', 'fleet-interface.fragment', 'fragment selection differs from verified proof');
  for (const entry of selected.entries) if (canonical(blocks[entry.id]) !== canonical(entry.block)) fail('INTERFACE_TAMPERED', entry.id, 'fragment fields differ from proven catalogue block');
  return freeze({ ...selected, consumer, consumer_digest: digest(consumer), proof_digest: digest(proof), fragment_digest: digest(fragment) });
}
