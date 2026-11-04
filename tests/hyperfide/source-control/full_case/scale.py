#!/usr/bin/env python3
"""Canonical scale cases require independently reverified completed real campaigns."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
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
    for tier, fields in [('source', ['service_id', 'replicas', 'cpu', 'memory_bytes', 'region', 'image_digest']), ('metadata', ['identity', 'replicas', 'cpu', 'memory_bytes', 'region']), ('objects', ['identity', 'region', 'storage_class'])]:
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
        profiles = run['topology'].get('source_profiles', [])
        require(len(profiles) == 2 and sorted(profile['replicas'] for profile in profiles) == [1, 2], 'Actual total deployed source profile must record three replicas')
        require(len({profile['service_id'] for profile in profiles}) == 2, 'Independent source service identities required')
        active = run['topology']['source']['service_id']
        require(any(profile['service_id'] == active and profile['replicas'] == run['topology']['source']['replicas'] for profile in profiles), 'Active source profile is absent')
        for profile in profiles:
            require(all(type(profile[key]) is int and profile[key] >= 0 for key in ['request_count_before', 'request_count_after', 'observed_from_ms', 'observed_through_ms']), 'Exact bounded source request counters required')
            count = profile['request_count_after'] - profile['request_count_before']
            require(count > 0 if profile['service_id'] == active else count == 0, 'Actual active/idle source request counts required')
            require(all(profile['observed_from_ms'] <= window['start_ms'] and profile['observed_through_ms'] >= window['end_ms'] for window in run['measurement_windows']), 'Source request observation window must cover measured work')
        budget = load(run['inputs']['config']['path'], True)['budgets']['max_growth_ratio']
        for getter in [lambda r: r['measurements']['checkpoint_rpc_ms']['p95'], lambda r: (r['server_after']['value']['storage_requests'] - r['server_before']['value']['storage_requests']) / r['measurements']['completed_operations'], lambda r: (r['server_after']['value']['storage_offered_write_bytes'] - r['server_before']['value']['storage_offered_write_bytes']) / r['measurements']['completed_operations']]:
            samples = [getter(row) for row in run['receipt']['results']]
            require(min(samples) > 0 and max(samples) / min(samples) <= budget, 'Declared latency/storage work growth budget exceeded')
    base_dimensions = dimensions(baseline)
    for run, field in zip(runs[1:4], ['unique_file_descriptors', 'directory_fanout', 'history_depth']):
        observed = dimensions(run)
        require(observed[field] > base_dimensions[field] and all(observed[key] == base_dimensions[key] for key in observed if key != field), 'Growth axes must vary one at a time')
        require({k: v for k, v in run['topology'].items() if k != 'source_profiles'} == {k: v for k, v in baseline['topology'].items() if k != 'source_profiles'}, 'Source shape comparison changed server resources')
    require(dimensions(runs[4]) == base_dimensions, 'Tier comparison changed source shape')
    first, second = baseline['topology'], runs[4]['topology']
    require(first['metadata'] == second['metadata'] and first['objects'] == second['objects'], 'Tier comparison changed storage or metadata resources')
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
