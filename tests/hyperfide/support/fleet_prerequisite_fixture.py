"""Owned PostgreSQL/TLS fleet fixture; no simulated model or provider adapters."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import socket
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[3]

def hierarchy_type():
    spec = importlib.util.spec_from_file_location('fleet_hierarchy_fixture', ROOT / 'tests/hyperfide/cases/tasks/3_1.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.HierarchyFixture

def component_closure(names):
    fragments = {}
    for filename in (ROOT / 'core/control-plane/components').glob('*.json'):
        if filename.name == 'schema.json':
            continue
        document = json.loads(filename.read_text())
        record = (filename.stem, document)
        fragments[document['id']] = record
        fragments.setdefault(filename.stem, record)
    found = set()
    def visit(name):
        if name not in fragments:
            raise RuntimeError('COMPONENT_UNAVAILABLE: ' + name)
        stem, fragment = fragments[name]
        if stem in found:
            return
        found.add(stem)
        for dependency in fragment.get('requires', []):
            visit(dependency)
    for name in names:
        visit(name)
    return sorted(found)

def private_json(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    return path

def model_environment(directory):
    """Use existing local authorization in place; never copy its credential files."""
    if (ROOT / '.env').is_file():
        # Node owns dotenv parsing; selected secrets stay in captured memory only.
        script = "console.log(JSON.stringify(Object.fromEntries(['CHAT_COMPLETIONS_URL','MODEL','CLUSTER_1_GATEWAY_API_KEY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))))"
        selected = json.loads(subprocess.check_output(['node', '--env-file=' + str(ROOT / '.env'), '-e', script], text=True, timeout=10))
        if all(selected.get(k) for k in ['CHAT_COMPLETIONS_URL', 'MODEL', 'CLUSTER_1_GATEWAY_API_KEY']):
            return {**selected, 'HYPERFIDE_FLEET_MODEL_BACKEND':'gateway',
                    'HYPERFIDE_FLEET_HOST_ID':socket.gethostname()}
    binary = os.environ.get('HYPERFIDE_FLEET_CODEX_BINARY')
    if not binary:
        candidates = sorted(Path('/root/.vscode-server/extensions').glob('openai.chatgpt-*/bin/linux-x86_64/codex'))
        if not candidates:
            raise RuntimeError('CAPABILITY_MISSING: configured local Codex binary')
        binary = str(candidates[-1].resolve())
    home = Path(os.environ.get('HYPERFIDE_FLEET_CODEX_HOME', '/root/.codex'))
    model = os.environ.get('HYPERFIDE_FLEET_CODEX_MODEL')
    if not model:
        model = tomllib.loads((home / 'config.toml').read_text()).get('model')
    if not model:
        raise RuntimeError('CAPABILITY_MISSING: configured local Codex model')
    version = subprocess.check_output([binary, '--version'], text=True, timeout=10).strip()
    if not version.startswith('codex-cli '):
        raise RuntimeError('CAPABILITY_MISSING: recognized Codex version')
    spool = directory / 'model-spool'
    spool.mkdir(mode=0o700)
    return {'HYPERFIDE_FLEET_HOST_ID': socket.gethostname(),
            'HYPERFIDE_FLEET_CODEX_BINARY': binary,
            'HYPERFIDE_FLEET_CODEX_BINARY_DIGEST': 'sha256:' + hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
            'HYPERFIDE_FLEET_CODEX_BINARY_VERSION': version.removeprefix('codex-cli '),
            'HYPERFIDE_FLEET_CODEX_HOME': str(home),
            'HYPERFIDE_FLEET_CODEX_SPOOL': str(spool),
            'HYPERFIDE_FLEET_CODEX_MODEL': model}

def supervisor_config(fixture, host):
    f = fixture
    actors = {}
    for name in ['leader', 'manager', 'manager2']:
        actors[name] = {'session_id':f.ids[name],
            'credential_file':str(f.path / (name + '.supervisor.json')),
            'key_file':str(f.keys[name]['path'])}
    operator = private_json(f.path / 'supervisor-operator.json', {
        'schema_version':1, 'credential_id':f.ids['operator'], 'actor_id':f.ids['operator'],
        'organisation_id':f.ids['organisation'], 'run_id':f.ids['run'],
        'role':'OPERATOR', 'authority_epoch':f.ids['epoch'], 'key_file':str(f.keys['operator']['path'])})
    import uuid
    return private_json(f.path / 'supervisor.json', {
        'schema_version': 1, 'origin': f.origin, 'ca_file': str(f.ca),
        'organisation_id': f.ids['organisation'], 'run_id': f.ids['run'],
        'cohort_id': str(uuid.uuid4()), 'host_id': host, 'leader_generation': '0',
        'expected_cohort_generation': '0', 'primary': actors['leader'],
        'managers': [actors['manager'], actors['manager2']],
        'bootstrap':{'operator_credential_file':str(operator),'ttl_seconds':900},
        'state_directory': str(f.path / 'supervisor-state'),
        'poll_interval_ms': 1000, 'request_timeout_ms': 120000})

def assert_untrusted_runner_receipt_refused(fixture, operation_id, receipt, key='runner'):
    """A signed runner's asserted receipt cannot replace captured native finalization.

    Actual READY/replay and receipt-integrity cases belong to the central delivery
    collect boundary after real native PREPARATION execution, never this raw API.
    """
    status, response = fixture.invoke('fleet.install.complete', {
        'operation_id':operation_id, 'receipt':receipt,
        'receipt_digest':receipt['receipt_digest']}, component='fleet-install', key=key)
    if response.get('error', {}).get('code') != 'FLEET_INSTALL_NATIVE_ISOLATION_REQUIRED':
        raise AssertionError('Asserted runner receipt bypassed native isolation finalization')
    return [{'id':'raw-runner-ready-proof-refused','status':'PASS'}]

def register_owned_environment(f, repository_path, revision):
    """Real signed registration only: image pin is a declared fixture input.

    This does not establish image availability, admission, installation or READY.
    Source/runtime/configuration bytes are actual owned artifacts.
    """
    script = r'''
import fs from 'node:fs/promises';
import {createGitSourceManifest} from './core/control-plane/dist/preparation/fleet_source.js';
import {parseNeron,parsePackage,digest,canonical,createInterfaceIndex,selectInterfaces,verifyFleetInterfaceSelection} from './contracts/fleet/index.mjs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const i=JSON.parse(Buffer.concat(chunks));
let n=await fs.readFile('spec/hyperfide-source-control/examples/fleet/.neron','utf8');
const runtimePath=process.execPath,runtime=await fs.readFile(runtimePath),runtimeDigest=digest(runtime);
const revision='git:'+i.revision;
const catalogue='[interface.worker.run]\nkind = "cli_command"\npath = "worker.mjs"\nline = 1\nsignature = "node worker.mjs"\ncallers = []\nstatus = "authored"\ncontract = "Execute the actual pinned worker source."\nnotes = "Authored fixture interface; no execution readiness claim."\n';
const index=createInterfaceIndex({catalogue,sourceRevision:revision,provenance:{kind:'authored',source_revision:revision,producer:'fleet-qualification',version:'1',input_digest:digest(catalogue)}});
n=n.replace('example = true','example = false').replace('https://source.example.invalid/api/v1/source-control',i.origin+'/api/v1/source-control').replace('example-paxeer-monorepo',i.repository).replace('git:'+'0'.repeat(40),revision).replace('example-authority-epoch',i.epoch).replace(/^read_scope = .*$/m,'read_scope = ["worker.mjs"]').replace(/^write_scope = .*$/m,'write_scope = ["worker.mjs"]');
let p=await fs.readFile('spec/hyperfide-source-control/examples/fleet/package.kvx','utf8');
p=p.replace('example = true','example = false').replaceAll('sha256:'+'0'.repeat(64),runtimeDigest).replaceAll('git:'+'0'.repeat(40),revision).replace(/^config_digest = .*$/m,'config_digest = "'+digest(parseNeron(n))+'"').replace(/^paths = .*$/m,'paths = ["worker.mjs"]').replace(/^selected_ids = .*$/m,'selected_ids = ["interface.worker.run"]').replace(/^catalogue_digest = .*$/m,'catalogue_digest = "'+digest(catalogue)+'"');
// Dependency declarations remain schema inputs here, never claimed installed.
const manifest=await createGitSourceManifest({repositoryPath:i.repository_path,repository:i.repository,revision,paths:['worker.mjs'],maxFiles:10,maxBytes:65536});
const parsed=parsePackage(p,{neron:parseNeron(n)}),config=Buffer.from('{"qualification":"registration-only"}\n');
const selected=await selectInterfaces(index,{ids:parsed.interfaces.selected_ids,sourceRevision:revision,catalogueDigest:digest(catalogue),maxBlocks:16,maxBytes:65536});
const consumerId='environment.'+parsed.environment.environment_id;
const proof={schema_version:1,kind:'hyperfide.fleet-interface-proof',publication:index.publication,entries:selected.entries,consumer:{kind:'hyperfide.fleet-interface-consumer',consumer_id:consumerId,package_digest:digest(parsed),source_revision:revision,selected_ids:parsed.interfaces.selected_ids}};
await verifyFleetInterfaceSelection({fragment:catalogue,proof,expected:{publicationDigest:digest(index.publication),proofDigest:digest(proof),consumerId,packageDigest:digest(parsed),sourceRevision:revision,catalogueDigest:digest(catalogue),ids:parsed.interfaces.selected_ids,maxBlocks:16,maxBytes:65536}});
const plan={schema_version:1,kind:'hyperfide.fleet-install-plan',package_digest:digest(parsed),source_config_digest:digest(parseNeron(n)),source_manifest_digest:manifest.digest,runtime_files:[{path:runtimePath,digest:runtimeDigest}],configuration_versions:[{name:'runtime',reference:'config-ref:fleet-host-runtime',version:'owned-registration-v1',digest:digest(config)}],interface_fragment_digest:digest(catalogue),interface_publication_digest:digest(index.publication),interface_proof_digest:digest(proof),interface_consumer_id:consumerId,source_files:manifest.entries.map(e=>({mount:'code',path:e.path,digest:e.digest,size:e.size,mode:e.mode}))};
await fs.mkdir('build/fleet/0.14',{recursive:true});await fs.writeFile('build/fleet/0.14/registration-interface-proof.json',canonical(proof)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({package_kvx:p,source_config_kvx:n,source_manifest_digest:manifest.digest,plan_digest:digest(plan),install_plan:plan}));
'''
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
        input=json.dumps({'origin':f.origin,'repository':f.ids['repository'],'epoch':f.ids['epoch'],
                         'revision':revision,'repository_path':str(repository_path)}),
        capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise AssertionError('Owned registration input construction failed: ' + result.stderr[:1200])
    payload = json.loads(result.stdout)
    def call(value, key='operator'):
        return f.invoke('fleet.install.register', value, component='fleet-install', key=key)
    status, response = call(payload, 'provisioner')
    if response.get('error', {}).get('code') != 'FLEET_INSTALL_SCOPE':
        raise AssertionError('Nonoperator executable plan registration not refused')
    results = [{'id':'install-register-nonoperator-denied','status':'PASS'}]
    status, response = call(payload)
    if status != 200 or response.get('ok') is not True:
        raise AssertionError('Pinned operator registration refused: ' + json.dumps(response))
    expected = response['result']
    status, response = call(payload)
    if response.get('result') != expected:
        raise AssertionError('Exact registration replay changed identity')
    results.append({'id':'install-register-pinned-plan-replay','status':'PASS'})
    import copy
    for field in ['source_manifest_digest', 'plan_digest']:
        changed = copy.deepcopy(payload)
        changed[field] = 'sha256:' + '1' * 64
        status, response = call(changed)
        if response.get('error', {}).get('code') != 'FLEET_INSTALL_INVALID':
            raise AssertionError('Drifted registration ' + field + ' not refused')
        results.append({'id':'install-register-' + field + '-drift-denied','status':'PASS'})
    return results
