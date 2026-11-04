#!/usr/bin/env python3
"""Canonical scale cases require independently reverified completed real campaigns."""
import argparse
import base64
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('scale_qualifier', ROOT / 'tests/hyperfide/qualify.py')
Q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(Q)
VARIANTS = {'SCM-020': ['growth'], 'SCM-021': ['mixed-load', 'open-admission'], 'SCM-022': ['real-s3-72h', 'real-worker']}
COMMON = ['pinned-real-inputs-and-resources', 'authoritative-ledgers-and-cleanup', 'real-source-and-storage-readback', 'latency-and-pressure-observations']
EXTRA = {
 'growth': ['fixed-change-three-sizes', 'cold-edit-content', 'independent-content-fanout-history', 'independent-source-tier-scaling', 'bounded-latency-and-storage-work'],
 'mixed-load': ['five-thousand-active-workspaces', 'hundred-per-second-five-minutes', 'distinct-durable-revisions'],
 'open-admission': ['twenty-million-opens-within-day', 'logical-not-materialized-opens'],
 'real-s3-72h': ['seventy-two-elapsed-hours', 'hundred-thousand-new-revisions-each-day', 'renewed-credentials-and-real-faults'],
 'real-worker': ['actual-independent-worker-revisions', 'worker-and-load-revisions-separated', 'real-worker-fault-and-cleanup-evidence'],
}


def case_checks(case):
    variants = VARIANTS[case]
    return COMMON + list(dict.fromkeys(check for variant in variants for check in EXTRA[variant]))


def require(value, message):
    if not value:
        raise ValueError(message)


def load(filename, private=False):
    path = Path(filename).absolute()
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_size <= 16 * 1024 * 1024, 'Unsafe or oversized evidence file')
    if private:
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, 'Private campaign configuration required')
    return json.loads(path.read_bytes())


def pin(filename):
    path = Path(filename).absolute()
    before = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(before.st_mode), 'Unsafe evidence pin')
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(data)
    after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'Evidence changed while hashing')
    return {'path': str(path), 'sha256': hasher.hexdigest()}


def identity(report):
    return {key: report[key] for key in ['source_scope', 'endpoint']}


COUNTER_FIELDS = ['request_count_before', 'request_count_after', 'observed_from_ms', 'observed_through_ms']


def evidence_document(reference):
    require(isinstance(reference, dict) and set(reference) == {'path', 'sha256'}, 'Pinned raw topology evidence required')
    require(pin(reference['path'])['sha256'] == reference['sha256'].removeprefix('sha256:'), 'Raw topology evidence changed')
    return load(reference['path'])


def validate_backend_counters(member, scope):
    evidence = member.get('request_counter_evidence', {})
    require(set(evidence) == {'before', 'after'}, 'Raw before and after backend counter evidence required')
    before, after = [evidence_document(evidence[key]) for key in ['before', 'after']]
    for sample in [before, after]:
        require(sample.get('schema_version') == 1 and sample.get('state') == 'RUNNING' and sample.get('coverage') == 'COMPLETE', 'Complete running backend counters required')
        require(sample.get('service_id') == member['service_id'] and sample.get('deployment_id') == member['deployment_id'] and sample.get('scope') == scope, 'Backend counter identity differs')
        require(isinstance(sample.get('boot_id'), str) and sample['boot_id'] and type(sample.get('requests')) is int and sample['requests'] >= 0, 'Backend counter boot and actual incoming request count required')
        require(isinstance(sample.get('listeners'), list) and sample['listeners'], 'Backend incoming request listener evidence required')
    require(before['boot_id'] == after['boot_id'], 'Backend restarted during the counter window')
    require(member['request_count_before'] == before['requests'] and member['request_count_after'] == after['requests'], 'Declared request counts differ from raw backend counters')
    for field, sample in [('observed_from_ms', before), ('observed_through_ms', after)]:
        instant = datetime.fromisoformat(sample['sampled_at'].replace('Z', '+00:00'))
        require(instant.tzinfo is not None and member[field] == int(instant.timestamp()) * 1000 + instant.microsecond // 1000, 'Declared counter window differs from raw sample time')


def validate_provider_member(member, backend):
    deployment = evidence_document(member.get('provider_readback'))['data']['deployment']
    require(deployment.get('id') == member['deployment_id'] and deployment.get('serviceId') == member['service_id'] and deployment.get('status') == 'SUCCESS', 'Raw Railway deployment membership differs')
    deploy = deployment['meta']['serviceManifest']['deploy']
    require(type(deploy.get('numReplicas')) is int and deploy['numReplicas'] == member['replicas'] == 1, 'Raw Railway replica count differs')
    regions = deploy['multiRegionConfig']
    require(set(regions) == {member['region']} and type(regions[member['region']].get('numReplicas')) is int and regions[member['region']]['numReplicas'] == 1, 'Raw Railway region or replica placement differs')
    limits = deploy['limitOverride']['containers']
    require(limits.get('cpu') == member['cpu'] and limits.get('memoryBytes') == member['memory_bytes'], 'Raw Railway resource allocation differs')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', member['image_digest']) and deployment['meta'].get('imageDigest') == member['image_digest'], 'Raw immutable Railway image identity differs')
    if backend:
        volumes = evidence_document(member.get('volume_readback'))['data']['environment']['volumeInstances']['edges']
        matches = [edge['node'] for edge in volumes if edge['node'].get('volumeId') == member['volume_id']]
        require(len(matches) == 1 and matches[0].get('serviceId') == member['service_id'] and matches[0].get('mountPath') == '/app/state', 'Raw Railway durable volume membership differs')


def validate_backend_state(member):
    startup = evidence_document(member.get('startup_readback'))
    journal = evidence_document(member.get('journal_readback'))
    volume = startup.get('volume', {})
    require(startup.get('schema_version') == 1 and startup.get('machine_id_origin') == 'railway-replica-id' and isinstance(startup.get('provider_replica_id'), str) and startup['provider_replica_id'], 'Actual Railway backend replica startup evidence required')
    require(volume.get('mounted') is True and volume.get('path') == '/app/state' and volume.get('mode') == '0700', 'Private durable backend volume must be mounted')
    require(journal.get('schema_version') == 1 and journal.get('state') == 'ACTIVE' and journal.get('pending') is None and journal.get('history'), 'Active adopted backend authority journal required')
    require(member['journal_identity']['path'] == '/app/state/authority-journal/' + journal['deployment_id'] + '.authority.json', 'Backend authority journal path differs')
    launch = evidence_document(member.get('launch_readback'))
    processes = [process for process in launch.get('processes', []) if '/app/core/control-plane/dist/control.js' in process.get('argv', [])]
    require(len(processes) == 1, 'Actual source service process required for authority binding')
    environment = processes[0].get('environment', {})
    require(environment.get('RAILWAY_SERVICE_ID') == member['service_id'] and environment.get('RAILWAY_DEPLOYMENT_ID') == member['deployment_id'], 'Launched source process physical deployment differs')
    require(environment.get('HYPERFIDE_DEPLOYMENT_ID') == journal['deployment_id'], 'Launched source process authority namespace differs')
    activation = evidence_document(member.get('activation_readback'))
    require(environment.get('HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256') == 'sha256:' + pin(member['activation_readback']['path'])['sha256'], 'Launched source bootstrap descriptor differs')
    adoption = activation.get('authority_adoption', {})
    require(activation.get('schema_version') == 1 and adoption.get('deployment_id') == journal['deployment_id'] and adoption.get('document_file') == 'authority-journal.json', 'Deployed authority adoption descriptor differs')
    activated = json.loads(base64.b64decode(activation['files']['authority-journal.json'], validate=True))
    require(all(activated.get(key) == journal.get(key) for key in ['deployment_id', 'document_digest', 'epoch', 'head_digest']), 'Adopted source journal differs from activated authority')
    return startup['provider_replica_id'], {key: journal[key] for key in ['deployment_id', 'document_digest', 'epoch', 'head_digest']}


def validate_proxy_routing(profile):
    proxy = profile['proxy']
    raw = evidence_document(proxy.get('routing_readback'))
    processes = [process for process in raw.get('processes', []) if process.get('service_id') == proxy['service_id'] and process.get('deployment_id') == proxy['deployment_id']]
    require(len(processes) == 1 and processes[0].get('pid') and processes[0].get('command') == ['node', '/app/proxy.mjs'], 'Actual running proxy process identity differs')
    process = processes[0]
    require(process.get('proxy_digest') == proxy.get('routing_script_digest') and re.fullmatch(r'sha256:[a-f0-9]{64}', proxy['routing_script_digest']), 'Running proxy script identity differs')
    origins = [member.get('origin') for member in profile['backends']]
    require(all(isinstance(origin, str) and origin.startswith('https://') for origin in origins) and len(set(origins)) == len(origins), 'Distinct HTTPS backend origins required')
    require(process.get('backends') == origins, 'Actual proxy routing membership differs')
    require(isinstance(proxy.get('origin'), str) and proxy['origin'].startswith('https://'), 'Explicit HTTPS proxy origin required')


INSTANCE_FILES = ['/etc/hostname', '/etc/hosts', '/etc/machine-id']
RUNTIME_ROOTS = ['/app (excluding /app/state)', '/opt', '/usr', '/etc']


def runtime_digest(rows, packages):
    return 'sha256:' + hashlib.sha256(json.dumps({'rows': rows, 'packages': packages}, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def validate_runtime_manifest(entry):
    raw = evidence_document({'path': str(ROOT / entry['raw_runtime_manifest']), 'sha256': entry['raw_runtime_manifest_sha256']})
    require(raw.get('schema_version') == 1 and isinstance(raw.get('rows'), list) and raw['rows'], 'Complete raw runtime manifest required')
    rows, names = raw['rows'], set()
    for row in rows:
        require(isinstance(row, list) and len(row) in [3, 4], 'Malformed runtime file row')
        path = row[0]
        require(isinstance(path, str) and path.startswith(('/app/', '/opt/', '/usr/', '/etc/')) and posixpath.normpath(path) == path and not path.startswith('/app/state/') and path != '/app/state' and '\x00' not in path and path not in names, 'Unsafe or duplicate runtime file row')
        names.add(path)
        if len(row) == 3:
            require(row[1] == 'link' and isinstance(row[2], str) and row[2] and '\x00' not in row[2], 'Malformed runtime symlink row')
        else:
            require(type(row[1]) is int and 0 <= row[1] <= 0o7777 and type(row[2]) is int and row[2] >= 0 and isinstance(row[3], str) and re.fullmatch(r'[a-f0-9]{64}', row[3]), 'Malformed runtime file mode, size or content hash')
        if path in INSTANCE_FILES:
            require(len(row) == 4 and not row[1] & 0o111, 'Allowed instance files must remain ordinary nonexecutable data')
    packages = raw.get('packages')
    require(isinstance(packages, str) and packages, 'Actual OS package inventory required')
    package_names = []
    for line in packages.splitlines():
        fields = line.split('\t')
        require(len(fields) == 2 and all(fields), 'Malformed OS package inventory')
        package_names.append(fields[0])
    require(len(set(package_names)) == len(package_names), 'Duplicate OS package inventory entry')
    require(raw.get('digest') == runtime_digest(rows, packages), 'Raw runtime manifest digest differs')
    normalized = [row for row in rows if row[0] not in INSTANCE_FILES]
    require(entry.get('row_count') == len(rows) and entry.get('instance_file_rows') == [row for row in rows if row[0] in INSTANCE_FILES], 'Runtime inventory count or allowed instance rows differ')
    require(entry.get('normalized_runtime_digest') == runtime_digest(normalized, packages), 'Normalized runtime manifest digest differs')
    return normalized, packages, {row[0]: row for row in rows}


def runtime_executable(rows, path):
    seen = set()
    while path in rows and len(rows[path]) == 3:
        require(path not in seen, 'Runtime executable symlink cycle')
        seen.add(path)
        target = rows[path][2]
        path = posixpath.normpath(target if target.startswith('/') else posixpath.join(posixpath.dirname(path), target))
    require(path in rows and len(rows[path]) == 4 and rows[path][1] & 0o111, 'Running executable absent from measured runtime')
    return 'sha256:' + rows[path][3]


def validate_runtime_launch(entry, member, rows, origin, backend):
    launch = evidence_document({'path': str(ROOT / entry['launch_readback']), 'sha256': entry['launch_readback_sha256']})
    processes = launch.get('processes', [])
    require(processes, 'Actual running runtime process readback required')
    if not backend:
        selected = [process for process in processes if process.get('service_id') == member['service_id'] and process.get('deployment_id') == member['deployment_id']]
        require(len(selected) == 1 and selected[0].get('command') == ['node', '/app/proxy.mjs'], 'Measured proxy launch identity differs')
        process = selected[0]
        require(process.get('proxy_digest') == member['routing_script_digest'] and process.get('executable_digest') == runtime_executable(rows, process['executable']), 'Measured proxy code or executable differs')
        require('/app/proxy.mjs' in rows and len(rows['/app/proxy.mjs']) == 4 and 'sha256:' + rows['/app/proxy.mjs'][3] == process['proxy_digest'], 'Running proxy code differs from measured runtime')
        return {'command': process['command'], 'cwd': process['cwd'], 'executable': process['executable'], 'executable_digest': process['executable_digest']}
    require(Path(entry['launch_readback']).resolve() == Path(member['launch_readback']['path']).resolve() and entry['launch_readback_sha256'].removeprefix('sha256:') == member['launch_readback']['sha256'].removeprefix('sha256:'), 'Runtime and authority launch readbacks differ')
    require(launch.get('service_id') == member['service_id'] and launch.get('deployment_id') == member['deployment_id'], 'Measured source launch service differs')
    configs = launch.get('configs', [])
    require(len(configs) == 1 and configs[0].get('origin') == origin, 'Measured source launch origin differs')
    config = configs[0]
    require(set(config) == {'generation', 'origin', 'identity_keys', 'identity_digest', 'policy_digest', 'authorization_digest', 'tls_ca_digest', 'database_ca_digest'}, 'Exact observed source launch configuration fields required')
    generation = config['generation']
    require(isinstance(generation, str) and generation and '/' not in generation, 'Exact source bootstrap generation required')
    prefix = '/app/state/bootstrap/' + generation + '/'
    activation = evidence_document(member['activation_readback'])
    require(activation.get('generation') == generation, 'Running configuration generation differs from deployed bootstrap')
    for field, filename in [('identity_digest', 'control-identity.json'), ('policy_digest', 'control-policy.json'), ('authorization_digest', 'source-authorization.json'), ('tls_ca_digest', 'tls-ca.crt'), ('database_ca_digest', 'database-ca.crt')]:
        require(config[field] == 'sha256:' + hashlib.sha256(base64.b64decode(activation['files'][filename], validate=True)).hexdigest(), 'Running configuration differs from deployed bootstrap: ' + filename)
    normalized = []
    for process in processes:
        require(process.get('executable_digest') == runtime_executable(rows, process['executable']) and process.get('cwd') == '/app', 'Measured source executable or working directory differs')
        argv = process.get('argv')
        require(isinstance(argv, list) and argv and argv[0] == process['executable'] and all(isinstance(arg, str) for arg in argv), 'Exact source process arguments required')
        require(all(not arg.startswith('/app/state/bootstrap/') or arg.startswith(prefix) for arg in argv), 'Source argument uses another bootstrap generation')
        normalized.append({'argv': [arg.replace(prefix, '/app/state/bootstrap/<generation>/', 1) if arg.startswith(prefix) else arg for arg in argv], 'executable': process['executable'], 'executable_digest': process['executable_digest'], 'cwd': process['cwd']})
    require(len(normalized) == 2 and sum('/app/deploy/hyperfide/fleet-control/start.mjs' in process['argv'] for process in normalized) == 1 and sum('/app/core/control-plane/dist/control.js' in process['argv'] for process in normalized) == 1, 'Exact source launcher and service processes required')
    identity = evidence_document(entry['identity_readback'])
    require(identity.get('origin') == origin and config['identity_digest'] == 'sha256:' + pin(entry['identity_readback']['path'])['sha256'], 'Measured identity configuration differs')
    return {'processes': sorted(normalized, key=lambda process: process['argv']), 'identity': {key: value for key, value in identity.items() if key != 'origin'}, 'config': {key: config[key] for key in ['identity_keys', 'policy_digest', 'authorization_digest', 'tls_ca_digest', 'database_ca_digest']}}


def validate_runtime_equivalence(topology, backends, proxies):
    report = evidence_document(topology['runtime_equivalence'])
    require(report.get('schema_version') == 1 and report.get('roots') == RUNTIME_ROOTS and report.get('allowed_instance_files') == INSTANCE_FILES, 'Exact runtime roots and three allowed instance paths required')
    for category, members, backend in [('sources', backends, True), ('proxies', proxies, False)]:
        entries = report.get(category, [])
        require(len(entries) == len(members) and {entry['service_id'] for entry in entries} == {member['service_id'] for member in members}, 'Exact measured runtime service membership required')
        observed = []
        for member in members:
            entry = next(entry for entry in entries if entry['service_id'] == member['service_id'])
            require(entry.get('oci_image_digest') == member['image_digest'], 'Measured runtime substituted actual OCI identity')
            normalized, packages, rows = validate_runtime_manifest(entry)
            origin = next(profile['proxy']['origin'] for profile in topology['source_profiles'] if member in profile['backends']) if backend else member['origin']
            launch = validate_runtime_launch(entry, member, rows, origin, backend)
            observed.append((normalized, packages, launch))
        require(all(value == observed[0] for value in observed), 'Deployed executable, configuration or OS package runtime differs')


def source_identity(profile):
    return {key: ([{name: value for name, value in member.items() if name not in COUNTER_FIELDS + ['request_counter_evidence']} for member in value] if key == 'backends' else value)
            for key, value in profile.items() if key not in COUNTER_FIELDS}


def validate_counter_window(profile, windows, active):
    require(all(type(profile.get(key)) is int and profile[key] >= 0 for key in COUNTER_FIELDS), 'Exact bounded source request counters required')
    require(profile['observed_from_ms'] <= profile['observed_through_ms'], 'Source request observation window is reversed')
    count = profile['request_count_after'] - profile['request_count_before']
    require(count > 0 if active else count == 0, 'Actual active/idle source request counts required')
    require(all(profile['observed_from_ms'] <= window['start_ms'] and profile['observed_through_ms'] >= window['end_ms'] for window in windows), 'Source request observation window must cover measured work')
    return count


def validate_service_profiles(topology, windows, scope):
    profiles = topology.get('source_profiles', [])
    require(len(profiles) == 2 and sorted(len(profile.get('backends', [])) for profile in profiles) == [1, 2], 'Exactly one-backend and two-backend source profiles required')
    require(all(profile.get('deployment_mode') == 'independent-services' for profile in profiles), 'Explicit independently deployed service topology required')
    require(len({profile['proxy']['service_id'] for profile in profiles}) == 2, 'Independent proxy services required')
    active = topology['source']['proxy']['service_id']
    require(sum(profile['proxy']['service_id'] == active for profile in profiles) == 1, 'Active source profile is absent or ambiguous')
    backends = [member for profile in profiles for member in profile['backends']]
    for field in ['service_id', 'deployment_id', 'volume_id']:
        require(all(isinstance(member.get(field), str) and member[field] for member in backends), 'Explicit backend identity required: ' + field)
        require(len({member[field] for member in backends}) == 3, 'Independent backend identities required: ' + field)
    require(not ({member['service_id'] for member in backends} & {profile['proxy']['service_id'] for profile in profiles}), 'Proxy and backend services must be distinct')
    proxies = [profile['proxy'] for profile in profiles]
    require(all(isinstance(proxy.get('deployment_id'), str) and proxy['deployment_id'] for proxy in proxies) and len({proxy['deployment_id'] for proxy in proxies} | {member['deployment_id'] for member in backends}) == 5, 'Distinct proxy and backend deployments required')
    journals = [member.get('journal_identity') for member in backends]
    require(all(isinstance(journal, dict) and set(journal) == {'volume_id', 'path'} and journal['volume_id'] == member['volume_id'] and isinstance(journal['path'], str) and journal['path'].startswith('/app/state/authority-journal/') for journal, member in zip(journals, backends)), 'Explicit backend volume journal identity required')
    require(len({(journal['volume_id'], journal['path']) for journal in journals}) == 3, 'Distinct physical backend journals required')
    resource_fields = ['cpu', 'memory_bytes', 'region', 'image_digest']
    comparable_fields = [field for field in resource_fields if field != 'image_digest' or 'runtime_equivalence' not in topology]
    resources = {field: backends[0].get(field) for field in resource_fields}
    require(type(resources['cpu']) in [int, float] and resources['cpu'] > 0 and type(resources['memory_bytes']) is int and resources['memory_bytes'] > 0 and all(isinstance(resources[field], str) and resources[field] for field in ['region', 'image_digest']), 'Complete positive backend resources and immutable image required')
    proxy_resources = {field: proxies[0].get(field) for field in comparable_fields + ['routing_script_digest']}
    require(type(proxy_resources['cpu']) in [int, float] and proxy_resources['cpu'] > 0 and type(proxy_resources['memory_bytes']) is int and proxy_resources['memory_bytes'] > 0 and isinstance(proxy_resources['region'], str) and proxy_resources['region'], 'Complete positive stateless proxy resources required')
    require(all(proxy.get('replicas') == 1 and type(proxy['replicas']) is int and {field: proxy.get(field) for field in proxy_resources} == proxy_resources for proxy in proxies), 'Stateless proxy replica resources or image differ')
    for proxy in proxies:
        validate_provider_member(proxy, False)
    for member in backends:
        validate_provider_member(member, True)
    if 'runtime_equivalence' in topology:
        validate_runtime_equivalence(topology, backends, proxies)
    state = [validate_backend_state(member) for member in backends]
    require(len({replica for replica, _ in state}) == 3, 'Distinct running Railway backend replicas required')
    require(all(authority == state[0][1] for _, authority in state), 'Source backends must share adopted authority')
    for profile in profiles:
        validate_proxy_routing(profile)
        selected = profile['proxy']['service_id'] == active
        if selected:
            require(source_identity(profile) == topology['source'], 'Active source descriptor differs from deployed profile')
        aggregate = validate_counter_window(profile, windows, selected)
        observed = 0
        for member in profile['backends']:
            require(member.get('replicas') == 1 and type(member['replicas']) is int, 'Each durable source backend must record its actual single replica')
            require({field: member.get(field) for field in comparable_fields} == {field: resources[field] for field in comparable_fields}, 'Source backend resources or image differ')
            observed += validate_counter_window(member, windows, selected)
            validate_backend_counters(member, scope)
        require(aggregate == observed, 'Source profile request count must equal backend request counts')
        require(profile['observed_from_ms'] == min(member['observed_from_ms'] for member in profile['backends']) and profile['observed_through_ms'] == max(member['observed_through_ms'] for member in profile['backends']), 'Profile window must exactly bound member counter observations')
    return profiles


def verify_run(row, kind, output):
    require(set(row) == {'id', 'manifest', 'config', 'preparation', 'topology'}, 'Explicit campaign matrix row required')
    require(row['id'] and all(c.isalnum() or c == '-' for c in row['id']), 'Unsafe campaign row identity')
    plan, config = load(row['manifest']), load(row['config'], True)
    require(plan['kind'] == kind and plan['real_backend'] is True, 'Actual declared workload kind required')
    before = {name: pin(row[name]) for name in ['manifest', 'config', 'preparation', 'topology']}
    topology_before = load(row['topology'])
    command = [sys.executable, 'tests/hyperfide/cases/source_control/6_2.py', '--campaign', row['manifest'], '--live-s3', '--deployment-config', row['config'], '--verify-completed']
    record, stdout, stderr = Q.run_child(command, ROOT, 14400, dict(os.environ))
    (output / (row['id'] + '-verification-stdout.log')).write_bytes(stdout)
    (output / (row['id'] + '-verification-stderr.log')).write_bytes(stderr)
    require(record['exit_code'] == 0 and not record['timed_out'] and not record.get('remaining_descendants') and not record.get('leaked_descendants'), 'Independent completed-campaign verifier failed: ' + row['id'])
    require(before == {name: pin(row[name]) for name in before}, 'Campaign matrix inputs changed during verification')
    directory = Path(config['output_directory'])
    receipt, proof = load(directory / 'receipt.json'), load(directory / 'verification.json')
    cleanup = load(directory / 'cleanup.json')
    require(receipt['status'] == proof['status'] == cleanup['status'] == 'PASS', 'Incomplete campaign or cleanup')
    require(receipt['manifest'] == plan and receipt['source_scope'] == config['scope'], 'Campaign plan or source scope changed')
    require(not cleanup['open_workspaces'] and not cleanup['open_intents'], 'Campaign left live custody')
    require(receipt['machine']['digest'] == plan['hardware_digest'], 'Client resource identity differs')
    windows = []
    for result in receipt['results']:
        metrics = result['measurements']
        with sqlite3.connect(Path(result['ledger'] + '.sqlite').absolute().as_uri() + '?mode=ro', uri=True) as database:
            start = database.execute("SELECT value FROM ledger_meta WHERE key='started_at_ms'").fetchone()[0]
        windows.append({'start_ms': start, 'end_ms': start + metrics['elapsed_ms']})
        require(metrics['completed_operations'] == plan['operations'] and metrics['rejected'] == 0, 'Incomplete or rejected offered work')
        for key in ['p50', 'p95', 'p99', 'max']:
            require(isinstance(metrics['latency_ms'][key], (float, int)), 'Measured operation distribution required')
        for phase in ['server_before', 'server_after']:
            observed = result[phase]['value']
            require(observed['deployment_identity'] == config['deployment_identity'] and observed['real_s3'] is True, 'Server resources or real storage differs')
            require(all(type(observed[key]) is int and observed[key] >= 0 for key in ['storage_requests', 'storage_bytes', 'storage_read_bytes', 'storage_offered_write_bytes', 'storage_acknowledged_write_bytes', 'storage_unknown_write_lengths', 'storage_failed_write_requests', 'storage_unknown_write_outcomes', 'queue_depth', 'lock_wait_ms', 'connection_count', 'publication_lag_ms', 'cache_hits', 'cache_misses', 'hydrated_bytes']), 'Incomplete measured pressure/cache/write observations')
            require(observed['storage_bytes'] == observed['storage_read_bytes'] and observed['storage_acknowledged_write_bytes'] <= observed['storage_offered_write_bytes'], 'Storage read/write accounting is inconsistent')
    preparation, topology = load(row['preparation']), load(row['topology'])
    require(all(topology[key] == topology_before[key] for key in ['scope', 'deployment_identity', 'topology']), 'Provider resource identity changed during verification')
    require(preparation['status'] == 'PASS' and preparation['scope'] == config['scope'], 'Actual prepared source inventory required')
    require(preparation['corpora'] == config['corpora'], 'Prepared roots differ from executed corpus roots')
    require(topology['scope'] == config['scope'] and topology['deployment_identity'] == config['deployment_identity'], 'Topology scope or deployment differs')
    source_fields = ['deployment_mode', 'proxy', 'backends'] if topology['topology'].get('source', {}).get('deployment_mode') == 'independent-services' else ['service_id', 'replicas', 'cpu', 'memory_bytes', 'region', 'image_digest']
    for tier, fields in [('source', source_fields), ('metadata', ['identity', 'replicas', 'cpu', 'memory_bytes', 'region']), ('objects', ['identity', 'region', 'storage_class'])]:
        require(all(field in topology['topology'].get(tier, {}) for field in fields), 'Complete actual provider resource profile required: ' + tier)
    require(topology.get('raw_evidence'), 'Raw provider topology evidence required')
    for evidence in topology['raw_evidence']:
        require(pin(evidence['path'])['sha256'] == evidence['sha256'].removeprefix('sha256:'), 'Raw topology evidence changed')
    observation = load(proof['observer']['receipt_file'])
    provider = [source for source in observation['sources'] if source['kind'] == 'provider-deployment-readback']
    measured = [source for source in observation['sources'] if source['kind'] == 'measured-topology']
    require(len(provider) == 1 and len(measured) == 1, 'Fresh provider readback and immutable measured topology are both required')
    require(Path(measured[0]['identity']).resolve() == Path(row['topology']).resolve() and measured[0]['sha256'] == 'sha256:' + pin(row['topology'])['sha256'], 'Measured topology differs from independently observed evidence')
    fresh = load(provider[0]['identity'])
    require(fresh['deployment_identity'] == config['deployment_identity'], 'Fresh provider resource identity differs from measured resources')
    return {'id': row['id'], 'inputs': {**before, 'topology': pin(row['topology'])}, 'receipt': receipt, 'verification': proof, 'verification_command': record, 'preparation': preparation, 'topology': topology['topology'], 'measurement_windows': windows, 'cleanup': cleanup}


def dimensions(run):
    values = [{name: corpus[name] for name in ['unique_file_descriptors', 'directory_fanout', 'history_depth']} for corpus in run['preparation']['corpora']]
    require(values and all(value == values[0] for value in values), 'Axes must remain constant across logical-size measurements')
    return values[0]


def validate_growth(runs):
    require([run['id'] for run in runs] == ['baseline', 'unique-content', 'directory-fanout', 'history-depth', 'source-tier'], 'Complete ordered growth matrix required')
    baseline = runs[0]
    fixed = {key: value for key, value in baseline['receipt']['manifest'].items() if key != 'backend_identity'}
    for run in runs:
        require({key: value for key, value in run['receipt']['manifest'].items() if key != 'backend_identity'} == fixed, 'Fixed client, change and workload profile required')
        require(run['receipt']['source_scope'] == baseline['receipt']['source_scope'], 'Growth must remain within one repository and security scope')
        if run['id'] != 'source-tier':
            require(run['receipt']['endpoint'] == baseline['receipt']['endpoint'], 'Source shape comparison changed endpoints')
        require([r['logical_files'] for r in run['receipt']['results']] == [10000, 1000000, 10000000], 'Three logical growth sizes required')
        require(fixed['modified_files'] == 10 and fixed['modified_bytes'] == 1048576, 'Fixed ten-file one-MiB change required')
        for row in run['receipt']['results']:
            require(row['content_condition']['profile'] == 'cold-unique-edit-objects', 'Equally cold edit objects required')
        if run['topology']['source'].get('deployment_mode') == 'independent-services':
            validate_service_profiles(run['topology'], run['measurement_windows'], run['receipt']['source_scope'])
            require(run['receipt']['endpoint'] == run['topology']['source']['proxy']['origin'], 'Measured source endpoint differs from the active proxy')
        else:
            profiles = run['topology'].get('source_profiles', [])
            require(len(profiles) == 2 and sorted(profile['replicas'] for profile in profiles) == [1, 2], 'Actual total deployed source profile must record three replicas')
            require(len({profile['service_id'] for profile in profiles}) == 2, 'Independent source service identities required')
            active = run['topology']['source']['service_id']
            require(any(profile['service_id'] == active and profile['replicas'] == run['topology']['source']['replicas'] for profile in profiles), 'Active source profile is absent')
            for profile in profiles:
                validate_counter_window(profile, run['measurement_windows'], profile['service_id'] == active)
        budget = load(run['inputs']['config']['path'], True)['budgets']['max_growth_ratio']
        for getter in [lambda r: r['measurements']['checkpoint_rpc_ms']['p95'], lambda r: (r['server_after']['value']['storage_requests'] - r['server_before']['value']['storage_requests']) / r['measurements']['completed_operations'], lambda r: (r['server_after']['value']['storage_offered_write_bytes'] - r['server_before']['value']['storage_offered_write_bytes']) / r['measurements']['completed_operations']]:
            samples = [getter(row) for row in run['receipt']['results']]
            require(min(samples) > 0 and max(samples) / min(samples) <= budget, 'Declared latency/storage work growth budget exceeded')
    base_dimensions = dimensions(baseline)
    for run, field in zip(runs[1:4], ['unique_file_descriptors', 'directory_fanout', 'history_depth']):
        observed = dimensions(run)
        require(observed[field] != base_dimensions[field] and all(observed[key] == base_dimensions[key] for key in observed if key != field), 'Growth axes must vary one at a time')
        require({k: v for k, v in run['topology'].items() if k != 'source_profiles'} == {k: v for k, v in baseline['topology'].items() if k != 'source_profiles'}, 'Source shape comparison changed server resources')
    require(dimensions(runs[4]) == base_dimensions, 'Tier comparison changed source shape')
    first, second = baseline['topology'], runs[4]['topology']
    require(first['metadata'] == second['metadata'] and first['objects'] == second['objects'], 'Tier comparison changed storage or metadata resources')
    if first['source'].get('deployment_mode') == 'independent-services':
        require(second['source'].get('deployment_mode') == 'independent-services', 'Source topology model changed between profiles')
        require(len(first['source']['backends']) == 1 and len(second['source']['backends']) == 2, 'Actual independently deployed one-versus-two source services required')
        require([source_identity(profile) for profile in first['source_profiles']] == [source_identity(profile) for profile in second['source_profiles']], 'Tier comparison changed deployed source profile membership')
    else:
        require(first['source']['replicas'] == 1 and second['source']['replicas'] == 2, 'Actual independently scaled source replicas required')
        require({k: v for k, v in first['source'].items() if k not in ['replicas', 'service_id']} == {k: v for k, v in second['source'].items() if k not in ['replicas', 'service_id']}, 'Source tier comparison changed additional resources')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=list(VARIANTS), required=True)
    parser.add_argument('--variant', required=True)
    args = parser.parse_args()
    require(args.variant in VARIANTS[args.case], 'Canonical case variant required')
    name = os.environ.get('HF_SOURCE_SCALE_PLAN')
    require(name, 'Explicit private scale matrix plan is required')
    config = load(name, True)
    require(config.get('schema_version') == 1 and isinstance(config.get('runs'), list), 'Versioned scale plan required')
    output = Path(os.environ['HYPERFIDE_CAMPAIGN_DIR'])
    output.mkdir(parents=True, exist_ok=True)
    if args.case == 'SCM-021':
        require([row['id'] for row in config['runs']] == ['mixed-load', 'open-admission'], 'Both full mixed-load and admission profiles are required')
        runs = [verify_run(row, kind, output) for row, kind in zip(config['runs'], ['mixed', 'admission'])]
    else:
        expected = ['baseline', 'unique-content', 'directory-fanout', 'history-depth', 'source-tier'] if args.case == 'SCM-020' else ['endurance']
        require([row['id'] for row in config['runs']] == expected, 'Exact ordered scale campaign profiles are required')
        kind = 'growth' if args.case == 'SCM-020' else 'endurance'
        runs = [verify_run(row, kind, output) for row in config['runs']]
    require(runs, 'Actual completed campaign required')
    if args.variant == 'growth':
        validate_growth(runs)
    else:
        require(len(runs) == (2 if args.case == 'SCM-021' else 1), 'Exact completed campaign profile set required')
        for run in runs:
            report = run['receipt'];plan = report['manifest'];kind = plan['kind']
            for row in report['results']:
                measured = row['measurements']
                if kind == 'mixed':
                    require(plan['clients'] >= 5000 and measured['completed_operations'] >= 30000 and measured['elapsed_ms'] >= 300000 and measured['observed_submission_rate'] >= 100 and measured['new_revisions'] == measured['completed_operations'], 'Actual mixed-load capacity target not met')
                elif kind == 'admission':
                    require(measured['logical_opens'] >= 20000000 and measured['elapsed_ms'] <= 86400000 and measured['materialized_files'] == 0, 'Actual logical admission target not met')
                else:
                    require(plan['clients'] >= 5000 and measured['elapsed_ms'] >= 259200000 and all(value >= 100000 for value in measured['daily_new_revisions'][:3]), 'Actual elapsed endurance or daily new revisions target not met')
                    require(report['credential_versions_observed'] >= 2 and report['hook_receipts'], 'Renewal and actual fault receipts required')
                    require(report['worker_new_revisions'] > 0 and any(hook['kind'] == 'worker-canary' for hook in report['hook_receipts']), 'Actual independent Hyperfide worker evidence required')
    (output / 'scale-evidence.json').write_text(json.dumps({'schema_version': 1, 'case': args.case, 'variant': args.variant, 'plan': pin(name), 'runs': runs}, indent=2) + '\n')
    for check in case_checks(args.case):
        print(json.dumps({'type': 'assertion', 'id': args.case + '.' + check, 'expected': True, 'actual': True}))
    print(json.dumps({'type': 'cleanup', 'complete': True, 'resources': []}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError) as error:
        print(json.dumps({'status': 'BLOCKED', 'diagnostic': str(error)}))
        raise SystemExit(77)
