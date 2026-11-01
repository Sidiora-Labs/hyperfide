#!/usr/bin/env python3
from pathlib import Path
import json
import hashlib
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
PROGRAM = r'''
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir, chmod, rename, link, symlink, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const c = await import(pathToFileURL(path.join(root, 'contracts/fleet/index.mjs')).href);
const results = [];
async function check(id, action) {
  try { await action(); results.push({ id, outcome: 'PASS' }); }
  catch (error) { results.push({ id, outcome: 'FAIL', code: error.code ?? error.name, message: error.message }); }
}
function refused(code, action) { assert.throws(action, error => error instanceof c.ContractError && error.code === code); }
async function refusedAsync(code, action) { await assert.rejects(action, error => error instanceof c.ContractError && error.code === code); }
const clone = value => JSON.parse(JSON.stringify(value));
const encode = doc => Object.entries(doc).map(([section, values]) => '[' + section + ']\n' + Object.entries(values).map(([key, value]) => key + ' = ' + JSON.stringify(value)).join('\n')).join('\n\n') + '\n';
const sampleRoot = path.join(root, 'spec/hyperfide-source-control/examples/fleet');
const sampleNeron = await readFile(path.join(sampleRoot, '.neron'), 'utf8');
const samplePackage = await readFile(path.join(sampleRoot, 'package.kvx'), 'utf8');
const sampleInterfaces = await readFile(path.join(sampleRoot, 'interfaces.kvx'), 'utf8');
const sha = 'sha256:' + 'a'.repeat(64), source = 'git:' + 'b'.repeat(40);
let config = clone(c.parseNeron(sampleNeron, { allowExamples: true }));
config.meta.example = false; config.source.endpoint = 'https://source.test/api/v1/source-control'; config.source.revision = source;
config = c.parseNeron(encode(config));
let manifest = clone(c.parsePackage(samplePackage, { allowExamples: true }));
manifest.meta.example = false;
manifest.environment.image_digest = sha; manifest.bootstrap.installer_sha256 = sha; manifest.source.config_digest = c.digest(config);
manifest.interfaces.catalogue_digest = c.digest(sampleInterfaces); manifest.interfaces.source_revision = source;
for (const [key, values] of Object.entries(manifest)) {
  if (key.startsWith('toolchain.')) values.artifact_digest = sha;
  if (key.startsWith('dependency.')) values.lockfile_digest = sha;
}
await check('examples.parse-without-authority', () => {
  assert.equal(c.parseNeron(sampleNeron, { allowExamples: true }).meta.format, 'neron.source-config');
  assert.equal(c.parsePackage(samplePackage, { allowExamples: true }).meta.format, 'hyperfide.sandbox-package');
  refused('NON_RUNNABLE_EXAMPLE', () => c.parseNeron(sampleNeron));
  refused('NON_RUNNABLE_EXAMPLE', () => c.parsePackage(samplePackage));
});
await check('canonical-content-identity', () => {
  assert.equal(c.canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(c.digest({ b: 2, a: 1 }), 'sha256:' + createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
  assert.equal(c.digest(c.parseKvx('[a]\nx = "hash#inside" # outside\n')), c.digest(c.parseKvx('# comment\n[a]\nx="hash#inside"\n')));
  refused('INVALID_INTEGER', () => c.canonical({ x: Number.MAX_SAFE_INTEGER + 1 }));
});
await check('kvx.duplicates-and-injection', () => {
  refused('KVX_DUPLICATE_SECTION', () => c.parseKvx('[a]\nx=1\n[a]\ny=2\n'));
  refused('KVX_DUPLICATE_KEY', () => c.parseKvx('[a]\nx=1\nx=2\n'));
  refused('KVX_DUPLICATE_KEY', () => c.parseKvx('[a]\n__proto__="x"\n'));
  refused('KVX_INVALID', () => c.parseKvx('[a]\nx=$(touch /tmp/injected)\n'));
  refused('KVX_INVALID', () => c.parseKvx('[a]\nx={"a":1,"a":2}\n'));
  refused('INVALID_TEXT', () => c.parseKvx('[a]\nx=[1]\n'));
});
await check('source.strict-version-and-secret-fields', () => {
  const version = clone(config); version.meta.schema_version = 2; refused('UNSUPPORTED_SCHEMA', () => c.parseNeron(encode(version)));
  const secret = clone(config); secret.source.token = 'private-value'; refused('SCHEMA_INVALID', () => c.parseNeron(encode(secret)));
  const endpoint = clone(config); endpoint.source.endpoint = 'https://user:password@source.test/api'; refused('ENDPOINT_INVALID', () => c.parseNeron(encode(endpoint)));
});
await check('source.pinned-backend-and-generation', () => {
  const floating = clone(config); floating.source.revision = 'main'; refused('INVALID_SOURCE_REVISION', () => c.parseNeron(encode(floating)));
  const backend = clone(config); backend.source.source_backend = 'native'; refused('SOURCE_MISMATCH', () => c.parseNeron(encode(backend)));
  const boolean = clone(config); boolean.workspace.workspace_generation = true; refused('INVALID_INTEGER', () => c.parseNeron(encode(boolean)));
});
await check('source.path-and-scope-confinement', () => {
  const traversal = clone(config); traversal.workspace.read_scope = ['../private/**']; refused('PATH_ESCAPE', () => c.parseNeron(encode(traversal)));
  const widen = clone(config); widen.workspace.write_scope = ['core/host-daemon-other/**']; refused('SCOPE_MISMATCH', () => c.parseNeron(encode(widen)));
  const overlap = clone(config); overlap.client.dirty_directory = config.cache.directory + '/dirty'; refused('PATH_OVERLAP', () => c.parseNeron(encode(overlap)));
  assert.equal(c.scopeContains(['core/host-daemon/**'], 'core/host-daemon/src/fleet.ts'), true);
  assert.equal(c.scopeContains(['core/host-daemon/**'], 'core/host-daemon-extra/src/fleet.ts'), false);
});
await check('package.complete-pinned-manifest', () => {
  const parsed = c.parsePackage(encode(manifest), { neron: config });
  assert.equal(parsed.environment.environment_id, config.workspace.environment_id);
  assert.equal(Object.isFrozen(parsed['mount.code']), true);
  assert.equal(parsed.source.config_digest, c.digest(config));
});
await check('package.reject-source-and-environment-forgery', () => {
  const changed = clone(manifest); changed.source.config_digest = sha; refused('SOURCE_MISMATCH', () => c.parsePackage(encode(changed), { neron: config }));
  const environment = clone(manifest); environment.environment.environment_generation++; refused('ENVIRONMENT_MISMATCH', () => c.parsePackage(encode(environment), { neron: config }));
  const revision = clone(manifest); revision.interfaces.source_revision = 'git:' + 'c'.repeat(40); refused('SOURCE_MISMATCH', () => c.parsePackage(encode(revision), { neron: config }));
});
await check('package.mount-config-and-overlay-isolation', () => {
  const escape = clone(manifest); escape['mount.code'].target = '/outside'; refused('PATH_ESCAPE', () => c.parsePackage(encode(escape), { neron: config }));
  const widen = clone(manifest); widen['mount.code'].paths = ['private/**']; refused('SCOPE_MISMATCH', () => c.parsePackage(encode(widen), { neron: config }));
  const overlay = clone(manifest); overlay.workers.home_template = overlay.workers.source_template; refused('PATH_OVERLAP', () => c.parsePackage(encode(overlay), { neron: config }));
  const secret = clone(manifest); secret['configuration.runtime'] = {kind:'secret-ref',reference:'secret-ref:credential',target:'/sandbox/config/secret',mode:'0644',required:true}; refused('SECRET_MODE_INVALID', () => c.parsePackage(encode(secret), { neron: config }));
});
await check('package.lock-toolchain-and-readiness-drift', () => {
  const version = clone(manifest); version['dependency.node'].version = '99.0.0'; refused('DEPENDENCY_DRIFT', () => c.parsePackage(encode(version), { neron: config }));
  const bypass = clone(manifest); bypass['dependency.node'].argv.push('--no-frozen-lockfile'); refused('DEPENDENCY_DRIFT', () => c.parsePackage(encode(bypass), { neron: config }));
  const stages = clone(manifest); stages.install.stages.reverse(); refused('INSTALL_ORDER_INVALID', () => c.parsePackage(encode(stages), { neron: config }));
  const probes = clone(manifest); probes.readiness.require_probes = []; refused('READINESS_INVALID', () => c.parsePackage(encode(probes), { neron: config }));
});
const decision = {schema_version:1,kind:'hyperfide.fleet-decision',decision_id:'decision-1',operation_id:'operation-1',run_id:'run-1',actor_id:'primary-1',actor_role:'PRIMARY',authority_epoch:'epoch-1',leader_generation:'1',delegation_id:null,manager_generation:null,source_revision:source,spec_revision:'spec-1',context_digest:sha,action:'DELEGATE_WAVE',input:{wave_id:'wave-1'},input_digest:c.digest({wave_id:'wave-1'}),expected_version:'1',rationale_summary:'Delegate the admitted wave.'};
await check('decision.explicit-model-choice-and-input-binding', () => {
  assert.equal(c.validateDecision(decision).action, 'DELEGATE_WAVE');
  const forged = clone(decision); forged.input.wave_id = 'wave-2'; refused('DIGEST_MISMATCH', () => c.validateDecision(forged));
  const missing = clone(decision); delete missing.action; refused('SCHEMA_INVALID', () => c.validateDecision(missing));
  const unknown = clone(decision); unknown.action = 'AUTO_FALLBACK'; refused('INVALID_VALUE', () => c.validateDecision(unknown));
  refused('BINDING_MISMATCH', () => c.validateDecision(decision, {expected:{authority_epoch:'epoch-2'}}));
});
await check('decision.manager-scope-and-install-action', () => {
  const manager = clone(decision); manager.actor_role = 'WAVE_MANAGER'; manager.actor_id = 'manager-1'; manager.delegation_id = 'delegation-1'; manager.manager_generation = '2'; manager.action = 'fleet.install.admit';
  assert.equal(c.validateDecision(manager).manager_generation, '2');
  manager.manager_generation = null; refused('INVALID_GENERATION', () => c.validateDecision(manager));
});
const assignment = {schema_version:1,kind:'hyperfide.task-assignment',assignment_id:'assignment-1',operation_id:'operation-2',decision_id:'decision-2',run_id:'run-1',wave_id:'wave-1',delegation_id:'delegation-1',manager_id:'manager-1',manager_generation:'2',leader_generation:'1',authority_epoch:'epoch-1',environment_id:config.workspace.environment_id,environment_generation:1,ready_receipt_digest:sha,source_revision:source,package_digest:c.digest(manifest),source_config_digest:c.digest(config),worker_id:'worker-1',worker_slot:0,tasks:[{task_id:'task-1',attempt_id:'attempt-1',attempt_generation:'1',read_scope:['core/host-daemon/**'],write_scope:['core/host-daemon/src/**'],required_interfaces:['interface.fleet.install'],provided_interfaces:[]}],limits:{max_runtime_seconds:300,max_output_bytes:1000000}};
await check('assignment.individual-attempts-and-ready-binding', () => {
  assert.equal(c.validateAssignment(assignment, {expected:{allowedTaskIds:['task-1'],environment_generation:1}}).tasks[0].attempt_id, 'attempt-1');
  assert.equal(c.validateAssignment(assignment).worker_slot, 0);
  const invalidSlot = clone(assignment); invalidSlot.worker_slot = 1024; refused('INVALID_INTEGER', () => c.validateAssignment(invalidSlot));
  refused('BINDING_MISMATCH', () => c.validateAssignment(assignment, {expected:{allowedTaskIds:['task-2']}}));
  refused('BINDING_MISMATCH', () => c.validateAssignment(assignment, {expected:{ready_receipt_digest:'sha256:'+'c'.repeat(64)}}));
  const duplicate = clone(assignment); duplicate.tasks.push(clone(duplicate.tasks[0])); refused('DUPLICATE_IDENTITY', () => c.validateAssignment(duplicate));
  const packageConfusion = clone(assignment); packageConfusion.kind = 'hyperfide.sandbox-package'; refused('UNSUPPORTED_SCHEMA', () => c.validateAssignment(packageConfusion));
});
const origin = {kind:'authored',source_revision:source,producer:'contract-author',version:'1',input_digest:sha};
const extra = '[interface.fleet.extra]\nkind="c_symbol"\npath="core/native/src/main.c"\nline=1\nsignature="main"\ncallers=[]\nstatus="stable"\ncontract="docs/contract.md"\nnotes="Unicode π café"\n';
const catalogue = sampleInterfaces + '\n' + extra;
const index = c.createInterfaceIndex({catalogue,sourceRevision:source,provenance:origin,references:{'interface.fleet.install':['interface.fleet.source-config']}});
const request = {ids:['interface.fleet.install'],sourceRevision:source,catalogueDigest:c.digest(catalogue),maxBlocks:4,maxBytes:65536};
await check('interfaces.preserve-block-fields-and-provenance', () => {
  const parsed = c.parseInterfaces(sampleInterfaces); assert.equal(parsed['interface.fleet.install'].kind, 'cli_command'); assert.equal(parsed['interface.fleet.install'].line, 1);
  const unknown = sampleInterfaces + '\nmalicious = "field"\n'; refused('SCHEMA_INVALID', () => c.parseInterfaces(unknown));
});
await check('interfaces.indexed-bounded-declared-closure', async () => {
  const fetched = [];
  const selected = await c.selectInterfaces({publication:index.publication,fetchEntry:async id => {fetched.push(id);return index.fetchEntry(id);}}, {...request,required:['interface.fleet.source-config']});
  assert.deepEqual(fetched, ['interface.fleet.install','interface.fleet.source-config']);
  assert.deepEqual(selected.selected_ids, fetched); assert.equal(selected.compatibility, 'UNVERIFIED'); assert.equal(selected.coverage, 'DECLARED_CLOSURE'); assert.equal(selected.entries[0].provenance.kind, 'authored');
  await refusedAsync('LIMIT_EXCEEDED', () => c.selectInterfaces(index, {...request,maxBlocks:1}));
  await refusedAsync('LIMIT_EXCEEDED', () => c.selectInterfaces(index, {...request,maxBytes:1}));
});
await check('interfaces.source-missing-and-stale-consumer', async () => {
  await refusedAsync('SOURCE_MISMATCH', () => c.selectInterfaces(index, {...request,sourceRevision:'git:'+'c'.repeat(40)}));
  await refusedAsync('MISSING_INTERFACE', () => c.selectInterfaces(index, {...request,ids:['interface.missing']}));
  await refusedAsync('STALE_INTERFACE', () => c.selectInterfaces(index, {...request,expectedBlocks:{'interface.fleet.install':sha}}));
  await refusedAsync('MISSING_INTERFACE', () => c.selectInterfaces(index, {...request,provided:['interface.fleet.extra']}));
});
await check('interfaces.reject-tampered-content-and-membership', async () => {
  const entry = clone(await index.fetchEntry('interface.fleet.extra')); entry.block.notes = 'changed'; entry.block_digest = c.digest(entry.block);
  await refusedAsync('INTERFACE_TAMPERED', () => c.selectInterfaces({publication:index.publication,fetchEntry:async()=>entry}, {...request,ids:[entry.id]}));
  const valid = clone(await index.fetchEntry('interface.fleet.extra')); valid.provenance.kind = 'extracted';
  await refusedAsync('INTERFACE_TAMPERED', () => c.selectInterfaces({publication:index.publication,fetchEntry:async()=>valid}, {...request,ids:[valid.id]}));
});
await check('interfaces.streaming-index-external-storage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-interface-index-'));
  try {
    const file = path.join(directory,'catalogue.kvx'); await writeFile(file,catalogue);
    const store = await c.createDirectoryInterfaceStore(path.join(directory,'index'));
    const streamed = await c.buildInterfaceIndex({chunks:createReadStream(file,{highWaterMark:13}),sourceRevision:source,provenance:origin,store});
    const selected = await c.selectInterfaces(streamed,{...request,ids:['interface.fleet.extra']});
    assert.equal(streamed.entries,undefined); assert.equal(selected.entries.length,1); assert.equal(selected.entries[0].block.notes,'Unicode π café');
    assert.equal(selected.catalogue_digest,'sha256:'+createHash('sha256').update(catalogue).digest('hex'));
    const staged = clone(await store.get('interface.fleet.extra')); staged.block.path = 'other.c'; await store.put(staged.id,staged);
    await refusedAsync('INTERFACE_TAMPERED',()=>c.selectInterfaces(streamed,{...request,ids:[staged.id]}));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
await check('interfaces.persistent-store-malformed-and-shared-records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-interface-store-'));
  try {
    const location = path.join(directory, 'index'), store = await c.createDirectoryInterfaceStore(location);
    const entry = await index.fetchEntry('interface.fleet.install');
    await store.put(entry.id, entry);
    const [name] = await readdir(location), record = path.join(location, name), shared = path.join(directory, 'shared.json');
    await rename(record, shared); await link(shared, record); await chmod(shared, 0o444);
    assert.equal(c.canonical(await store.get(entry.id)), c.canonical(entry));
    await chmod(shared, 0o600); await writeFile(shared, '{truncated');
    await refusedAsync('INTERFACE_INVALID', () => store.get(entry.id));
    await unlink(record); await symlink(shared, record);
    await refusedAsync('INTERFACE_INVALID', () => store.get(entry.id));
    await unlink(record);
    await refusedAsync('LIMIT_EXCEEDED', () => store.put(entry.id, {payload:'x'.repeat(2 * 1024 * 1024)}));
    assert.deepEqual(await readdir(location), []);
    const moved = path.join(directory, 'moved'); await rename(location, moved); await symlink(moved, location);
    await refusedAsync('PATH_ESCAPE', () => store.get(entry.id));
  } finally { await rm(directory, {recursive:true,force:true}); }
});
await check('interfaces.store-without-linux-descriptor-filesystem', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-interface-portable-'));
  try {
    const entry = await index.fetchEntry('interface.fleet.install');
    const code = 'import {createDirectoryInterfaceStore} from ' + JSON.stringify(pathToFileURL(path.join(root,'contracts/fleet/index.mjs')).href) + ';const s=await createDirectoryInterfaceStore(' + JSON.stringify(path.join(directory,'index')) + ');const e=' + JSON.stringify(entry) + ';await s.put(e.id,e);if((await s.get(e.id)).block_digest!==e.block_digest)throw Error("Stored public block changed");';
    execFileSync(process.execPath, ['--permission', '--allow-fs-read=' + path.join(root,'contracts/fleet/index.mjs'), '--allow-fs-read=' + directory, '--allow-fs-write=' + directory, '--input-type=module', '-e', code], {stdio:['ignore','pipe','pipe']});
  } finally { await rm(directory, {recursive:true,force:true}); }
});
await check('interfaces.invalid-stream-and-index-version', async () => {
  await refusedAsync('INTERFACE_INVALID',()=>c.buildInterfaceIndex({chunks:[new Uint8Array([0xff])],sourceRevision:source,provenance:origin}));
  await refusedAsync('UNSUPPORTED_SCHEMA',()=>c.selectInterfaces({...index,publication:{...index.publication,schema_version:2}},request));
  await refusedAsync('SOURCE_MISMATCH',()=>c.buildInterfaceIndex({chunks:[catalogue],sourceRevision:source,provenance:{...origin,source_revision:'git:'+'c'.repeat(40)}}));
});
await check('interfaces.install-membership-and-consumer', async () => {
  const ids=['interface.fleet.install','interface.fleet.source-config'];
  const selection=await c.selectInterfaces(index,{...request,ids});
  const proof={schema_version:1,kind:'hyperfide.fleet-interface-proof',publication:index.publication,entries:selection.entries,consumer:{kind:'hyperfide.fleet-interface-consumer',consumer_id:'environment.fleet',package_digest:sha,source_revision:source,selected_ids:ids}};
  const fragment=encode(Object.fromEntries(selection.entries.map(entry=>[entry.id,entry.block])));
  const expected={publicationDigest:c.digest(index.publication),proofDigest:c.digest(proof),consumerId:'environment.fleet',packageDigest:sha,sourceRevision:source,catalogueDigest:c.digest(catalogue),ids,maxBlocks:4,maxBytes:65536};
  const verified=await c.verifyFleetInterfaceSelection({fragment,proof,expected});
  assert.equal(verified.fragment_digest,c.digest(fragment));assert.equal(verified.compatibility,'UNVERIFIED');
  await refusedAsync('INTERFACE_CONSUMER_MISMATCH',()=>c.verifyFleetInterfaceSelection({fragment,proof,expected:{...expected,consumerId:'other.consumer'}}));
  const forged=clone(proof);forged.entries[0].block.notes='forged';
  await refusedAsync('INTERFACE_TAMPERED',()=>c.verifyFleetInterfaceSelection({fragment,proof:forged,expected:{...expected,proofDigest:c.digest(forged)}}));
  const blocks=clone(c.parseInterfaces(fragment));blocks[ids[0]].contract='changed';
  await refusedAsync('INTERFACE_TAMPERED',()=>c.verifyFleetInterfaceSelection({fragment:encode(blocks),proof,expected}));
  await refusedAsync('LIMIT_EXCEEDED',()=>c.verifyFleetInterfaceSelection({fragment,proof,expected:{...expected,maxBlocks:1}}));
  await refusedAsync('INTERFACE_TAMPERED',()=>c.verifyFleetInterfaceSelection({fragment,proof,expected:{...expected,publicationDigest:sha}}));
});
await check('package.private-configuration-target-contract', () => {
  const valid=clone(manifest);valid['configuration.runtime'].target=valid.workers.home_template+'/.config/runtime.json';valid['configuration.runtime'].mode='0600';
  assert.equal(c.parsePackage(encode(valid))['configuration.runtime'].target,valid['configuration.runtime'].target);
  const global=clone(valid);global['configuration.runtime'].target='/sandbox/config/runtime.json';refused('CONFIGURATION_TARGET_INVALID',()=>c.parsePackage(encode(global)));
  const escape=clone(valid);escape['configuration.runtime'].target=valid.workers.source_template+'/runtime.json';refused('CONFIGURATION_TARGET_INVALID',()=>c.parsePackage(encode(escape)));
  const shared=clone(valid);shared['configuration.runtime'].mode='0444';shared['configuration.runtime'].target='/sandbox/config/runtime.json';assert.equal(c.parsePackage(encode(shared))['configuration.runtime'].mode,'0444');
});
const failed = results.filter(result => result.outcome === 'FAIL');
console.log(JSON.stringify({status:failed.length?'FAIL':'PASS',scope:'fleet-contract-parser-and-index',checks:results.length,results,productQualification:false},null,2));
process.exitCode = failed.length ? 1 : 0;
'''

def main():
    node = os.environ.get('HYPERFIDE_NODE_BINARY', 'node')
    result = subprocess.run([node, '--input-type=module', '-e', PROGRAM, str(ROOT)], cwd=ROOT,
                            text=True, capture_output=True, timeout=90)
    if result.returncode:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    evidence = json.loads(result.stdout)
    revision = subprocess.check_output(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], cwd=ROOT, text=True).strip()
    tree = subprocess.check_output(['git', 'rev-parse', '--verify', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
    inputs = ['contracts/fleet/index.mjs', 'contracts/fleet/index.d.mts',
              'spec/hyperfide-source-control/examples/fleet/.neron',
              'spec/hyperfide-source-control/examples/fleet/package.kvx',
              'spec/hyperfide-source-control/examples/fleet/interfaces.kvx',
              'tests/hyperfide/cases/source_control/0_10.py']
    evidence['source_binding'] = {'baseline_revision': 'git:' + revision, 'baseline_tree': tree,
                                  'working_inputs': {name: 'sha256:' + hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in inputs},
                                  'fixture_authority': 'CONTROLLED_PARSER_AND_INDEX_INPUTS'}
    sys.stdout.write(json.dumps(evidence, indent=2) + '\n')
    sys.stderr.write(result.stderr)
    return 0

if __name__ == '__main__':
    sys.exit(main())
