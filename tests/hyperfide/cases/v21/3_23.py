#!/usr/bin/env python3
"""hyperfide-v21 3.23: provider resolution Asks live in the asks store.

Runs the real provisioner service (components 8.2, 8.3, 6.1 and 1.2-asks) over
signed HTTPS against an owned, ephemeral PostgreSQL cluster (the pattern of
v21/2_1.py, whose cluster helpers this case reuses). Proves that an overdue
orphan and QUARANTINED intent are raised into hyperfide.asks and listed by
human.ask.list, that human.ask.answer settles the provider inventory, that
migration 0715 copies an open 0708 row and freezes the old table, and that a
freshly imported run has its operator:asks consumer.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / 'services/hyperfide/migrations'
FAILED = []
OBSERVED = []


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load('v21_2_1_cluster', 'tests/hyperfide/cases/v21/2_1.py')
expect = base.expect


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    OBSERVED.append({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual})
    print(json.dumps(OBSERVED[-1]), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    sys.exit(77)


# Runs statements in one SERIALIZABLE transaction as the cluster superuser and returns the last result's rows.
# replica=True seeds rows without their foreign-key chains (session_replication_role disables FK and row triggers).
PG_JS = r"""
const fs=require('fs'),{createRequire}=require('module'),pg=createRequire(process.cwd()+'/services/hyperfide/package.json')('pg');
(async()=>{const q=JSON.parse(fs.readFileSync(0,'utf8')),c=new pg.Client({connectionString:process.env.HF_PG_URL});await c.connect();
 try{await c.query(q.autocommit?'SELECT 1':'BEGIN ISOLATION LEVEL SERIALIZABLE');if(q.replica)await c.query('SET LOCAL session_replication_role=replica');
  let rows=[];try{for(const [sql,values] of q.statements)rows=(await c.query(sql,values)).rows;if(!q.autocommit)await c.query('COMMIT');}catch(e){if(!q.autocommit)await c.query('ROLLBACK');throw e;}
  process.stdout.write(JSON.stringify(rows));}finally{await c.end();}
})().catch(e=>{process.stderr.write(JSON.stringify({code:e.code??'SQL_ERROR',message:e.message}));process.exitCode=1;});
"""

MIGRATE_JS = r"""
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {MigrationCoordinator} from './services/hyperfide/dist/storage/durability.js';
const signal=new AbortController().signal,env={...process.env,DATABASE_URL:process.env.HF_PG_URL,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.HF_PG_URL};
const r=createResourceContainer({role:'control',env,signal});
try{process.stdout.write(JSON.stringify(await new MigrationCoordinator(r,process.env.HF_MIGRATIONS_DIR||undefined).apply({timeoutMs:30000,signal})));}
finally{await r.close();}
"""

IMPORT_JS = r"""
import {createRequire} from 'node:module';
import {importRunTransaction} from './services/hyperfide/dist/spec/import.js';
const pg=createRequire(process.cwd()+'/services/hyperfide/package.json')('pg');
const c=JSON.parse(process.env.HF_IMPORT),client=new pg.Client({connectionString:process.env.HF_PG_URL});await client.connect();
try{await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');const out=await importRunTransaction(client,c.scope,c.envelope);await client.query('COMMIT');process.stdout.write(JSON.stringify(out));}
catch(e){await client.query('ROLLBACK').catch(()=>{});process.stderr.write(String(e.code)+': '+e.message);process.exitCode=1;}
finally{await client.end();}
"""


def pg(url, statements, replica=False, fails=False, autocommit=False):
    env = os.environ.copy()
    env['HF_PG_URL'] = url
    p = subprocess.run(['node', '--input-type=commonjs', '-e', PG_JS],
                       input=json.dumps({'statements': statements, 'replica': replica, 'autocommit': autocommit}),
                       cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
    if fails:
        expect(p.returncode != 0, ('statement accepted', statements))
        return p.stderr
    expect(p.returncode == 0, ('statement failed', statements, p.stderr[:1200]))
    return json.loads(p.stdout)


def node(script, env_extra, timeout=360):
    env = os.environ.copy()
    env.update(env_extra)
    p = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
    expect(p.returncode == 0, ('node probe failed', p.stderr[-1500:]))
    return json.loads(p.stdout)


def scenario(intents):
    f = None
    try:
        def setup(fixture):
            intents.prepare_provider_intent_fixture(fixture)
            # The owner sets the real window per deployment (900 s recommended); this case owns its own.
            fixture.env['HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS'] = '1'
        f = intents.pools.ProvisionerFixture(extra_components=['8.2', '8.3', '6.1', '1.2-asks'], extra_setup=setup)
        org, run_id = f.ids['organisation'], f.ids['run']

        def call(action, payload, key='operator', component='8.3'):
            return f.invoke(action, payload, component=component, key=key)

        def ok(action, payload, key='operator', component='8.3'):
            status, response = call(action, payload, key, component)
            expect(status == 200 and response.get('ok') is True, (action, status, response))
            return response['result']

        def refused(action, payload, needle, key='operator', component='8.3'):
            status, response = call(action, payload, key, component)
            expect(status >= 400 or response.get('ok') is False, (action, 'accepted', response))
            expect(needle in json.dumps(response), (action, 'expected ' + needle, response))

        def listed(state=None, key='operator'):
            return {a['ask_id']: a for a in ok('human.ask.list', {'state': state, 'limit': 100}, key=key, component='1.2-asks')['asks']}

        def answer(ask_id, value, key='operator'):
            current = listed()[ask_id]
            return call('human.ask.answer', {'ask_id': ask_id, 'expected_state_version': current['state_version'], 'answer': value}, key, '1.2-asks')

        def link(ask_id):
            rows = f.sql('SELECT subject_key,subject_kind,resolution_id::text FROM hyperfide.provider_resolution_ask_links WHERE organisation_id=$1 AND ask_id=$2', [org, ask_id])
            expect(len(rows) == 1, ('link missing', ask_id, rows))
            return rows[0]

        def intent_row(iid):
            return f.sql('SELECT state,failure_code FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND id=$2', [org, iid])[0]

        def create(reservations):
            request = {'run_id': run_id, 'pool_id': f.pool, 'sandbox_id': str(uuid.uuid4()), 'request_key': str(uuid.uuid4()),
                       'deadline_at': intents.utc(), 'reservation_ids': reservations, 'profile_id': f.profile,
                       'preparation_digest': f.preparation, 'purpose': 'PREPARATION'}
            status, response = call('provider.intents.prepare-create', request)
            expect(status == 200 and response.get('ok'), response)
            return response['result']['intent']['id']

        def quarantine(iid):
            f.sql("UPDATE hyperfide.provisioning_intents SET state='QUARANTINED',failure_code='OWNERSHIP_UNVERIFIED',updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [org, iid])

        ok('provider.pools.configure', {}, component='8.2')
        intents.seed_provider_capacity(f)
        first = f.reservations[:]
        iid = create(first)
        quarantine(iid)
        native = 'lost-create-' + iid
        f.sql('INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id,suspected_intent_id) VALUES($1,$2,$3,$4)', [org, f.pool, native, iid])
        orphan_key, intent_key = 'orphan:' + f.pool + ':' + native, 'intent:' + iid
        time.sleep(1.5)

        def channel_required():
            refused('provider.resolutions.escalate', {}, 'ASK_OPERATOR_CONSUMER_REQUIRED', key='provisioner')
            count = f.sql('SELECT count(*)::int AS n FROM hyperfide.provider_resolution_ask_links WHERE organisation_id=$1', [org])[0]['n']
            expect(count == 0, ('a refused escalation left links behind', count))
        check('v21.3.23.escalation-needs-operator-channel', channel_required)
        ok('outbox.consumer.register', {'organisation_id': org, 'run_id': run_id, 'id': str(uuid.uuid4()), 'consumer_key': 'operator:asks',
                                        'critical': False, 'state': 'ACTIVE'}, component='6.1')

        asks = {}

        def raised():
            result = ok('provider.resolutions.escalate', {}, key='provisioner')
            expect(set(result['raised']) == {orphan_key, intent_key}, result)
            for ask in result['open']:
                asks[ask['subject_key']] = ask['ask_id']
            expect(set(asks) == {orphan_key, intent_key}, asks)
            again = ok('provider.resolutions.escalate', {}, key='provisioner')
            expect(again['raised'] == [] and len(again['open']) == 2, ('second escalation duplicated Asks', again))
        check('v21.3.23.escalation-raises-into-asks', raised)

        def in_list():
            open_asks = listed('OPEN')
            for key, options, recommended in ((orphan_key, ['RETAIN', 'DELETE'], 'RETAIN'), (intent_key, ['RELEASE', 'RETRY'], 'RELEASE')):
                ask = open_asks.get(asks[key])
                expect(ask is not None, ('provider Ask absent from human.ask.list', key, list(open_asks)))
                expect(ask['kind'] == 'decision' and ask['chain'] == ['operator'] and ask['default_policy'] == 'proceed-and-flag', ask)
                expect(ask['options'] == options and ask['recommended'] == recommended and ask['run_id'] == run_id and ask['deadline'], ask)
                expect(ask['raised_by'] == f.ids['provisioner'], ('raised by the escalating principal', ask))
                expect(link(asks[key])['subject_key'] == key, key)
            delivered = f.sql("SELECT count(*)::int AS n FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND event_type='ask.raised'", [org, run_id])[0]['n']
            expect(delivered >= 2, ('raise not delivered to the operator channel', delivered))
        check('v21.3.23.human-ask-list-shows-provider-asks', in_list)

        def evidence_refused():
            status, response = answer(asks[orphan_key], 'DELETE')
            expect(response.get('ok') is False and 'DELETION_EVIDENCE_REQUIRED' in json.dumps(response), response)
            expect(listed()[asks[orphan_key]]['state'] == 'OPEN', 'refused answer closed the Ask')
            expect(f.sql('SELECT state FROM hyperfide.provider_orphans WHERE organisation_id=$1 AND native_sandbox_id=$2', [org, native])[0]['state'] == 'QUARANTINED', 'orphan moved')
        check('v21.3.23.delete-answer-needs-evidence', evidence_refused)

        def provisioner_refused():
            status, response = answer(asks[orphan_key], 'RETAIN', key='provisioner')
            expect(response.get('ok') is False and 'cannot answer' in json.dumps(response), response)
        check('v21.3.23.non-operator-cannot-answer', provisioner_refused)

        def retained():
            status, response = answer(asks[orphan_key], 'RETAIN')
            expect(status == 200 and response.get('ok') is True, response)
            result = response['result']
            expect(result['ask']['state'] == 'ANSWERED' and result['ask']['answer'] == 'RETAIN', result)
            applied = result['applied']
            expect(applied['subject_key'] == orphan_key and applied['resolved'] is True and applied['state'] == 'RETAINED', applied)
            row = f.sql('SELECT state FROM hyperfide.provider_orphans WHERE organisation_id=$1 AND pool_id=$2 AND native_sandbox_id=$3', [org, f.pool, native])[0]
            expect(row['state'] == 'RETAINED', ('inventory row did not move', row))
            resolution = f.sql("SELECT id::text,resolution,decided_by_credential_id::text AS decider,reason FROM hyperfide.provider_resolutions WHERE organisation_id=$1 AND native_sandbox_id=$2", [org, native])
            expect(len(resolution) == 1 and resolution[0]['resolution'] == 'RETAIN' and resolution[0]['decider'] == f.ids['operator'] and asks[orphan_key] in resolution[0]['reason'], resolution)
            expect(link(asks[orphan_key])['resolution_id'] == resolution[0]['id'], 'link not settled by the resolution')
            report = ok('provider.pools.capacity', {'pool_id': f.pool}, component='8.2')
            expect(report['unknown_resource_capacity'] is False, ('retained orphan still unknown', report))
            status, response = answer(asks[orphan_key], 'RETAIN')
            expect(response.get('ok') is False and 'already answered' in json.dumps(response), ('answered twice', response))
        check('v21.3.23.answer-retain-moves-orphan', retained)

        def released():
            status, response = answer(asks[intent_key], 'RELEASE')
            expect(status == 200 and response.get('ok') is True, response)
            applied = response['result']['applied']
            expect(applied['resolved'] is True and applied['released_reservations'] == 4 and applied['intent']['state'] == 'REJECTED', applied)
            expect(intent_row(iid) == {'state': 'REJECTED', 'failure_code': 'OPERATOR_RELEASED'}, intent_row(iid))
            pending = f.sql("SELECT count(*)::int AS n FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) AND state='RELEASE_PENDING'", [org, run_id, first])[0]['n']
            expect(pending == 4, ('linked reservations not handed to admission', pending))
            expect(link(asks[intent_key])['resolution_id'], 'intent link not settled')
        check('v21.3.23.answer-release-moves-intent', released)

        def direct_resolution_closes_ask():
            intents.seed_provider_capacity(f)
            second = create(f.reservations[4:])
            quarantine(second)
            time.sleep(1.5)
            result = ok('provider.resolutions.escalate', {}, key='provisioner')
            expect(result['raised'] == ['intent:' + second], result)
            ask_id = next(a['ask_id'] for a in result['open'] if a['subject_key'] == 'intent:' + second)
            settled = ok('provider.intents.resolve-quarantine', {'intent_id': second, 'resolution': 'RETRY', 'reason': 'ownership probe installed', 'evidence_digest': None})
            expect(settled['settled_asks'] == [ask_id] and settled['intent']['state'] == 'UNKNOWN', settled)
            ask = listed()[ask_id]
            expect(ask['state'] == 'ANSWERED' and ask['answer'] == 'RETRY' and ask['answered_by'] == f.ids['operator'], ask)
            listing = ok('provider.resolutions.list', {'pool_id': f.pool})
            states = {a['subject_key']: a['state'] for a in listing['asks']}
            expect(states == {orphan_key: 'ANSWERED', intent_key: 'ANSWERED', 'intent:' + second: 'ANSWERED'} and listing['legacy_asks'] == [], listing)
        check('v21.3.23.direct-resolution-closes-ask', direct_resolution_closes_ask)

        def legacy_read_only():
            error = pg(f.url, [["INSERT INTO hyperfide.provider_resolution_asks(organisation_id,id,subject_key,subject_kind,pool_id,native_sandbox_id,title,options,recommended,window_seconds,subject_since,raised_by_credential_id) VALUES($1,$2,'orphan:x','ORPHAN',$3,'x','t','[]','RETAIN',1,now(),$4)",
                               [org, str(uuid.uuid4()), f.pool, f.ids['operator']]]], fails=True)
            expect('read-only history' in error, error)
        check('v21.3.23.legacy-table-read-only', legacy_read_only)

        def imported():
            root = Path(tempfile.mkdtemp(prefix='hf-v21-3-23-import-'))
            try:
                source = b'[task.99.1]\nwave = 1\n'
                name = uuid.uuid4().hex + '.kvx'
                (root / name).write_bytes(source)
                (root / name).chmod(0o600)
                repo, oid, new_run = str(uuid.uuid4()), hashlib.sha1(os.urandom(16)).hexdigest(), str(uuid.uuid4())
                pg(f.url, [["INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES($1,$2,$3,'v21-3-23','https://example.invalid/v21-3-23.git')", [org, repo, f.ids['project']]],
                           ["INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,'commit')", [org, repo, oid]]])
                scope = {'organisation_id': org, 'project_id': f.ids['project'], 'run_id': new_run, 'authority_epoch': f.ids['epoch'], 'root': str(root), 'allowed_actions': ['spec.import']}
                envelope = {'run_id': new_run, 'source': {'relative_path': name, 'sha256': hashlib.sha256(source).hexdigest(), 'size_bytes': str(len(source))},
                            'repositories': [{'repository_id': repo, 'source_object_id': oid, 'integration_ref': 'refs/heads/main'}], 'allowed_actions': ['spec.import'],
                            'closure_policy': {'required_evidence': ['synthetic.assertion'], 'required_review_roles': ['VERIFIER'], 'publication': 'AFTER_QUALIFICATION'}, 'provenance': None}
                result = node(IMPORT_JS, {'HF_PG_URL': f.url, 'HF_IMPORT': json.dumps({'scope': scope, 'envelope': envelope})})
                expect(result['run_id'] == new_run and result['replayed'] is False, result)
                rows = pg(f.url, [["SELECT consumer_key,state,critical FROM hyperfide.event_consumers WHERE organisation_id=$1 AND run_id=$2", [org, new_run]]])
                expect(rows == [{'consumer_key': 'operator:asks', 'state': 'BUFFERING', 'critical': False}], ('imported run lacks its operator channel', rows))
            finally:
                for item in root.iterdir():
                    item.unlink()
                root.rmdir()
        check('v21.3.23.import-registers-operator-asks', imported)
    finally:
        if f is not None:
            f.close()


def migration_proof(cluster):
    """0715 against a database that already holds open 0708 rows: every migration before 0715 first, then the release."""
    database = 'hf_v21_3_23_migration'
    pg(cluster.url(), [['CREATE DATABASE ' + database, []]], autocommit=True)
    url = cluster.url(database)
    partial = Path(tempfile.mkdtemp(prefix='hf-v21-3-23-migrations-'))
    try:
        for file in sorted(MIGRATIONS.glob('*.sql')):
            if file.name < '0715':
                (partial / file.name).write_bytes(file.read_bytes())
        node(MIGRATE_JS, {'HF_PG_URL': url, 'HF_MIGRATIONS_DIR': str(partial)})
    finally:
        for item in partial.iterdir():
            item.unlink()
        partial.rmdir()
    ids = {name: str(uuid.uuid4()) for name in ('org', 'project', 'spec', 'run', 'epoch', 'pool', 'cred', 'stranger', 'intent', 'sandbox', 'profile',
                                                 'orphan_ask', 'intent_ask', 'stray_ask')}
    digest = 'sha256:' + hashlib.sha256(b'v21-3-23').hexdigest()
    since = '2026-01-01T00:00:00Z'
    orphan_options = json.dumps([{'id': 'RETAIN', 'effect': 'keep'}, {'id': 'DELETE', 'effect': 'gone'}])
    intent_options = json.dumps([{'id': 'RELEASE', 'effect': 'free'}, {'id': 'RETRY', 'effect': 'again'}])
    legacy = "INSERT INTO hyperfide.provider_resolution_asks(organisation_id,id,subject_key,subject_kind,pool_id,native_sandbox_id,intent_id,title,options,recommended,window_seconds,subject_since,raised_by_credential_id,raised_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,900,$11,$12,$11)"
    pg(url, [
        ["INSERT INTO hyperfide.organisations(id,name) VALUES($1,'v21-3-23-migration')", [ids['org']]],
        ["INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES($1,$2,$3,$4,$5,$6,'RUNNING')",
         [ids['org'], ids['run'], ids['project'], ids['spec'], digest, ids['epoch']]],
        ["INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES($1,$2,'fixture','fixture','fixture','fixture')", [ids['org'], ids['pool']]],
        ["INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,allowed_actions,expires_at) VALUES($1,$2,$3,$1,'PROVISIONER',$4,$5,ARRAY['provider.resolutions.escalate'],now()+interval '1 hour')",
         [ids['cred'], ids['org'], ids['run'], 'A' * 43, ids['epoch']]],
        ["INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,boot_generation,failure_code) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,'v21-3-23',$6,$6,'{}','QUARANTINED',1,'OWNERSHIP_UNVERIFIED')",
         [ids['org'], ids['run'], ids['intent'], ids['pool'], ids['sandbox'], digest, ids['profile']]],
        [legacy, [ids['org'], ids['orphan_ask'], 'orphan:' + ids['pool'] + ':lost', 'ORPHAN', ids['pool'], 'lost', None, 'Retain or delete lost', orphan_options, 'RETAIN', since, ids['cred']]],
        [legacy, [ids['org'], ids['intent_ask'], 'intent:' + ids['intent'], 'INTENT', ids['pool'], None, ids['intent'], 'Release or retry', intent_options, 'RELEASE', since, ids['cred']]],
        # Raised by a credential no longer known and not tied to an intent: there is no run to list it under.
        [legacy, [ids['org'], ids['stray_ask'], 'orphan:' + ids['pool'] + ':stray', 'ORPHAN', ids['pool'], 'stray', None, 'Retain or delete stray', orphan_options, 'RETAIN', since, ids['stranger']]],
    ], replica=True)
    applied = node(MIGRATE_JS, {'HF_PG_URL': url})
    # Later releases (0716 onward) apply in the same run; nothing below 0715 may be pending.
    later = [int(file.name[:4]) for file in sorted(MIGRATIONS.glob('*.sql')) if file.name >= '0715']
    expect(applied['applied'] == later and later[0] == 715, ('only 0715 and later releases were pending', applied))

    def derived(old):
        return str(uuid.UUID(hashlib.md5(('hyperfide.provider-resolution-ask:' + ids['org'] + ':' + old).encode()).hexdigest()))

    def copied():
        rows = pg(url, [["SELECT a.id::text,a.run_id::text,a.kind,a.options,a.recommended,a.chain,a.default_policy,a.state,a.raised_by::text,a.raised_at=$2::timestamptz AS raised_kept,a.deadline>clock_timestamp()+interval '3 hours' AS fresh_deadline,l.migrated_from::text,l.subject_key,l.resolution_id FROM hyperfide.asks a JOIN hyperfide.provider_resolution_ask_links l ON l.organisation_id=a.organisation_id AND l.ask_id=a.id WHERE a.organisation_id=$1 ORDER BY l.subject_kind",
                         [ids['org'], since]]])
        expect(len(rows) == 2, ('expected the two attributable open rows', rows))
        intent_row, orphan_row = rows
        expect(intent_row['migrated_from'] == ids['intent_ask'] and intent_row['id'] == derived(ids['intent_ask']) and intent_row['options'] == ['RELEASE', 'RETRY'], intent_row)
        expect(orphan_row['migrated_from'] == ids['orphan_ask'] and orphan_row['id'] == derived(ids['orphan_ask']) and orphan_row['options'] == ['RETAIN', 'DELETE'], orphan_row)
        for row in rows:
            expect(row['run_id'] == ids['run'] and row['kind'] == 'decision' and row['chain'] == ['operator'] and row['default_policy'] == 'proceed-and-flag', row)
            expect(row['state'] == 'OPEN' and row['raised_by'] == ids['cred'] and row['raised_kept'] and row['fresh_deadline'] and row['resolution_id'] is None, row)
        events = pg(url, [["SELECT count(*)::int AS n FROM hyperfide.ask_events WHERE organisation_id=$1 AND event_type='RAISED'", [ids['org']]]])[0]['n']
        expect(events == 2, ('copied Asks lack their RAISED history', events))
        stray = pg(url, [["SELECT count(*)::int AS n FROM hyperfide.asks WHERE organisation_id=$1 AND id=$2", [ids['org'], derived(ids['stray_ask'])]]])[0]['n']
        expect(stray == 0, 'an Ask without a run was copied')
        kept = pg(url, [["SELECT count(*)::int AS n FROM hyperfide.provider_resolution_asks WHERE organisation_id=$1 AND state='OPEN'", [ids['org']]]])[0]['n']
        expect(kept == 3, ('old rows are history and stay as they were', kept))
    check('v21.3.23.migration-copies-open-0708-rows', copied)

    def frozen():
        error = pg(url, [["UPDATE hyperfide.provider_resolution_asks SET state_version=state_version+1 WHERE organisation_id=$1", [ids['org']]]], fails=True)
        expect('read-only history' in error, error)
        error = pg(url, [["DELETE FROM hyperfide.provider_resolution_asks WHERE organisation_id=$1", [ids['org']]]], fails=True)
        expect('read-only history' in error, error)
    check('v21.3.23.migration-freezes-0708-table', frozen)


def main():
    binaries = base.postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        skip('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    if os.geteuid() != 0:
        skip('the owned cluster runs initdb through runuser postgres, which needs root')
    # Only the owned cluster is reachable: never let an inherited database URL redirect the fixture.
    for key in list(os.environ):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del os.environ[key]
    cluster = None
    clean = False
    try:
        base.ensure_build()
        cluster = base.Cluster(binaries)
        os.environ['DATABASE_URL'] = cluster.url()
        intents = load('provider_intent_fixture', 'tests/hyperfide/cases/tasks/8_3.py')
        scenario(intents)
        migration_proof(cluster)
    except Exception as error:
        FAILED.append('fixture')
        print('fixture: ' + str(error)[:3000], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
        campaign = os.environ.get('HYPERFIDE_CAMPAIGN_DIR')
        if campaign:
            Path(campaign).mkdir(parents=True, exist_ok=True)
            (Path(campaign) / 'v21-3-23-observations.json').write_text(
                json.dumps({'assertions': OBSERVED, 'cluster_removed': clean}, indent=2) + '\n')
    if FAILED:
        print('FAILED: ' + ', '.join(FAILED), flush=True)
    else:
        print('PASS: v21 3.23 provider resolution Asks live in the asks store (' + str(len(OBSERVED)) + ' assertions)', flush=True)
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
