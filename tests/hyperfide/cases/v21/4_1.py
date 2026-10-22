#!/usr/bin/env python3
"""hyperfide-v21 4.1: the native-stream classifier writes Asks.

Two parts. The actual compiled classifier recognises Claude Code AskUserQuestion (as an assistant tool_use and as a
can_use_tool control request) and Codex item/tool/requestUserInput as a QUESTION signal while its normalized
classification still carries no native text. Then, on an owned throwaway PostgreSQL cluster (the v21/3_2.py pattern),
the control service runs in HTTPS mode with the 13.4 admission component wired to the 1.2-asks raise path; both native
shapes and a Claude approval prompt are fed through agent.admission.observe and the case asserts the Ask rows: kind,
default policy, deadline and chain from the kind (3.6 ASK_POLICY), options parsed from the event, the agent's own question text preserved, references to
the observed session, delivery to the operator consumer, and one Ask per native prompt across replays. Prints SKIP and
exits 77 when no PostgreSQL server or root is available.
"""
import hashlib, importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
COMPONENTS = ('6.1', '1.2-asks', '14.2', '14.3', '13.2', '13.4')
DIGEST = 'sha256:' + 'a' * 64

CLAUDE_QUESTIONS = [
    {'question': 'Which migration strategy should the worker use for the orders table?', 'header': 'Migration',
     'options': [{'label': 'Online copy (Recommended)', 'description': 'Copy rows in batches while writes continue.'},
                 {'label': 'Lock and rewrite', 'description': 'Take an exclusive lock for the rewrite.'}],
     'multiSelect': False},
    {'question': 'Which regions should receive the canary?', 'header': 'Regions',
     'options': [{'label': 'eu-west', 'description': 'Primary EU region.'}, {'label': 'us-east', 'description': 'Primary US region.'}],
     'multiSelect': True},
]
CLAUDE_EVENT = {'type': 'assistant', 'message': {'id': 'msg_1', 'role': 'assistant', 'content': [
    {'type': 'text', 'text': 'I need a decision before continuing.'},
    {'type': 'tool_use', 'id': 'toolu_01AskQ', 'name': 'AskUserQuestion', 'input': {'questions': CLAUDE_QUESTIONS}}]},
    'session_id': 'native-claude'}
CLAUDE_CONTROL = {'type': 'control_request', 'request_id': 'req-7', 'request': {'subtype': 'can_use_tool', 'tool_name': 'AskUserQuestion',
                                                                               'tool_use_id': 'toolu_01AskQ', 'input': {'questions': CLAUDE_QUESTIONS}}}
CODEX_EVENT = {'id': 41, 'method': 'item/tool/requestUserInput', 'params': {'threadId': 'thr_1', 'turnId': 'turn_1', 'itemId': 'call_ui_9', 'questions': [
    {'id': 'deploy_target', 'header': 'Target', 'question': 'Which environment should the smoke test run against?', 'isOther': True, 'isSecret': False,
     'options': [{'label': 'staging', 'description': 'Shared staging cluster.'}, {'label': 'production', 'description': 'Live traffic.'}]},
    {'id': 'api_token', 'header': 'Token', 'question': 'Paste the deploy token for the staging cluster.', 'isOther': False, 'isSecret': True, 'options': None}]}}
CLAUDE_APPROVAL = {'type': 'control_request', 'request_id': 'req-8', 'request': {'subtype': 'can_use_tool', 'tool_name': 'Bash', 'tool_use_id': 'toolu_02Bash',
                                                                                'input': {'command': 'rm -rf build/ && make release', 'description': 'Rebuild the release'}}}

CLASSIFIER = r"""
import {classifyNativeEvent as c} from './services/hyperfide/dist/agents/admission.js';
import {nativeAskRequests as a} from './services/hyperfide/dist/agents/native_asks.js';
const cases=JSON.parse(process.argv[1]);
console.log(JSON.stringify(cases.map(([connector,event])=>({classification:c(connector,event),asks:a(connector,event)}))));
"""
POLICY_PROBE = r"""
import {ASK_POLICY as p} from './services/hyperfide/dist/agents/admission.js';
console.log(JSON.stringify(p));
"""
POLICY = {}


def ask_policy(kind):
    # The 3.6 table is the source of the per-kind terms; read it from the compiled service rather than restating it.
    if not POLICY:
        result = subprocess.run(['node', '--input-type=module', '-e', POLICY_PROBE], cwd=ROOT, capture_output=True, text=True, timeout=30)
        expect(result.returncode == 0, 'compiled ASK_POLICY unavailable: ' + result.stderr[-1500:])
        POLICY.update(json.loads(result.stdout))
    return POLICY[kind]


def follows_policy(row):
    p = ask_policy(row['kind'])
    return row['default_policy'] == p['default_policy'] and row['deadline_s'] == p['deadline_seconds'] and row['chain'] == p['chain']


def uid():
    return str(uuid.uuid4())


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def expect(value, message):
    if not value:
        raise AssertionError(message)


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)[:1500]
        FAILED.append(name)
    print(json.dumps({'type': 'assertion', 'id': 'native-ask.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def classify(cases):
    result = subprocess.run(['node', '--input-type=module', '-e', CLASSIFIER, json.dumps(cases)], cwd=ROOT, capture_output=True, text=True, timeout=30)
    expect(result.returncode == 0, 'compiled classifier unavailable: ' + result.stderr[-1500:])
    return json.loads(result.stdout)


def classifier_checks():
    def shapes():
        out = classify([['claude', CLAUDE_EVENT], ['claude', CLAUDE_CONTROL], ['codex', CODEX_EVENT], ['claude', CLAUDE_APPROVAL]])
        for item, code in zip(out[:3], ('AskUserQuestion', 'AskUserQuestion', 'item/tool/requestUserInput')):
            c = item['classification']
            expect(c['signal'] == 'QUESTION' and c['reason'] is None and c['code'] == code and c['useful_progress'] is False, 'not a QUESTION signal: ' + json.dumps(c))
            expect('migration' not in json.dumps(c).lower() and 'environment' not in json.dumps(c), 'native text leaked into the normalized classification')
        expect(out[3]['classification']['signal'] == 'APPROVAL_PROMPT' and out[3]['classification']['reason'] == 'APPROVAL_REQUIRED', 'Bash permission is no longer an approval prompt')
    check('classifier.question-signal-both-shapes', shapes)

    def text_kept():
        out = classify([['claude', CLAUDE_EVENT], ['codex', CODEX_EVENT]])
        claude, codex = out[0]['asks'], out[1]['asks']
        expect(len(claude) == 2 and all(a['kind'] == 'question' for a in claude), 'Claude questions not extracted: ' + json.dumps(claude))
        expect(claude[0]['body'].startswith(CLAUDE_QUESTIONS[0]['question']) and 'Copy rows in batches while writes continue.' in claude[0]['body'], 'question text not preserved')
        expect(claude[0]['options'] == ['Online copy (Recommended)', 'Lock and rewrite'] and claude[0]['recommended'] == 'Online copy (Recommended)', 'options not parsed')
        expect(claude[1]['recommended'] == 'eu-west' and 'More than one option' in claude[1]['body'], 'multi-select question not described')
        expect([a['kind'] for a in codex] == ['question', 'secret'] and codex[0]['options'] == ['staging', 'production'] and codex[1]['options'] == [], 'Codex questions not parsed: ' + json.dumps(codex))
        expect(CODEX_EVENT['params']['questions'][1]['question'] in codex[1]['body'], 'Codex secret question text not preserved')
    check('classifier.text-and-options-preserved', text_kept)

    def negatives():
        out = classify([['codex', {'method': 'item/tool/requestUserInput', 'params': {'questions': []}}],
                        ['codex', {'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': 'Which environment?'}}}],
                        ['claude', {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Should I proceed?'}]}}],
                        ['claude', {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {}}]}}]])
        expect(out[0]['classification']['signal'] == 'IGNORED' and out[0]['asks'] == [], 'a notification without a request id became a question')
        expect(all(o['classification']['signal'] == 'IGNORED' and o['asks'] == [] for o in out[1:]), 'ordinary messages raised Asks: ' + json.dumps(out))
    check('classifier.negatives-raise-nothing', negatives)


def setup(f):
    """Two native sessions (Claude and Codex workers) each on its own task attempt, bound and holding an admission reservation."""
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    for key in ('package', 'leader', 'artifact'):
        i[key] = uid()
    f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'native-asks',4)", [o, r, i['package']])
    f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES($1,$2,$3,'LEADER','claude','fixture','native-leader','RUNNING')", [o, r, i['leader']])
    f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status) VALUES($1,$2,$3,$4,24,'fixture','fixture-diagnostic','COMPLETE')", [o, r, i['artifact'], DIGEST])
    policies = []
    for n, connector in enumerate(('claude', 'codex')):
        t, slot, attempt, session, reservation = uid(), uid(), uid(), uid(), uid()
        i[connector] = {'task': t, 'slot': slot, 'attempt': attempt, 'session': session, 'reservation': reservation, 'quota': connector + '-quota'}
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',4)",
              [o, r, t, '4.1-' + connector, i['package'], i['spec'], DIGEST])
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,$4,1,'AGENT')", [o, slot, i['sandbox'], 'native-' + connector])
        f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) "
              "VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '30 minutes')", [o, r, attempt, t, i['epoch'], DIGEST, i['sandbox'], slot])
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) "
              "VALUES($1,$2,$3,'WORKER',$4,$5,'fixture',$6,$7,$8,1,$9,'RUNNING')", [o, r, session, i['leader'], connector, 'native-' + connector, slot, i['sandbox'], attempt])
        f.sql("INSERT INTO hyperfide.native_session_bindings(organisation_id,run_id,session_id,connector_version,auth_profile,configuration_digest,source_manifest_digest,process_id,process_start_time,boot_id) "
              "VALUES($1,$2,$3,'1.0.0','fixture-native',$4,$4,$5,'1',$6)", [o, r, session, DIGEST, 100 + n, i['boot']])
        policy = {'organisation_id': o, 'run_id': r, 'run_policy_digest': sha(b'policy'), 'quota_key': connector + '-quota', 'connector': connector, 'connector_version': '1.0.0',
                  'provider': 'fixture-provider', 'model': 'fixture-model', 'auth_profile': 'fixture-native', 'permission_profile': 'fixture-permissions',
                  'qualification_digest': DIGEST, 'max_concurrent': 4, 'max_attempts': 2, 'retry_base_ms': 1000, 'retry_max_ms': 2000, 'unattended': True, 'native_delegation': False}
        policies.append(policy)
        f.sql("INSERT INTO hyperfide.agent_admission_accounts(organisation_id,run_id,quota_key,policy_digest,max_concurrent,active) VALUES($1,$2,$3,$4,4,1)", [o, r, policy['quota_key'], sha(canonical(policy))])
        f.sql("INSERT INTO hyperfide.agent_admission_reservations(organisation_id,run_id,id,quota_key,session_id,payload_digest,policy_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,'RESERVED')",
              [o, r, reservation, policy['quota_key'], session, DIGEST, sha(canonical(policy))])
    admission = f.path / 'admission.json'
    admission.write_text(json.dumps({'schema_version': 1, 'policies': policies}))
    admission.chmod(0o600)
    f.env['HF_AGENT_ADMISSION_POLICY_FILE'] = str(admission)
    # 13.4 requires the 13.2/14.3 native components, which load pinned profiles and the credential store at startup.
    binary = pathlib.Path(os.path.realpath(shutil.which('true') or '/bin/true'))
    home = f.path / 'native-home'
    home.mkdir(mode=0o700)
    os.chown(home, 1001, 1001)
    profile = {'schema_version': 1, 'profile_id': 'fixture-native', 'profile_revision': '1', 'connector': 'claude', 'auth_mode': 'account_session',
               'binary': {'path': str(binary), 'digest': sha(binary.read_bytes()), 'version': '1.0.0'}, 'credential_reference': 'fixture-reference',
               'configured_model_alias': 'fixture-frontier', 'requested_model_id': 'fixture-model', 'configured_provider_id': 'fixture-provider',
               'permission_profile_id': 'fixture-permissions', 'capabilities': {'unattended': True, 'refresh': False, 'concurrent_account': False, 'portable_session': False, 'explicit_resume': True},
               'runtime_home': str(home), 'target_uid': 1001, 'configured_account_key': 'fixture'}
    profiles = f.path / 'native-profiles.json'
    profiles.write_text(json.dumps({'schema_version': 1, 'profiles': [profile]}))
    profiles.chmod(0o600)
    f.env['HF_NATIVE_AUTH_PROFILES_FILE'] = str(profiles)
    secrets, attachments = f.path / 'secrets', f.path / 'attachments'
    secrets.mkdir(mode=0o700)
    attachments.mkdir(mode=0o700)
    store = f.path / 'credential-store.json'
    store.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
    store.chmod(0o600)
    f.env['HF_CREDENTIAL_CONFIG_FILE'] = str(store)


def scenario(f):
    i = f.ids
    o, r = i['organisation'], i['run']

    def observe(connector, event, operation=None, refs=False, key='operator'):
        s = i[connector]
        payload = {'scope': {'organisation_id': o, 'run_id': r, 'session_id': s['session']}, 'reservation_id': s['reservation'],
                   'operation_id': operation or uid(), 'connector': connector, 'event': event}
        if refs:
            payload['diagnostic_refs'] = [i['artifact']]
        return f.invoke('agent.admission.observe', payload, key=key, component='13.4')[1]

    def ok(response, label):
        expect(response.get('ok') is True, label + ' failed: ' + json.dumps(response)[:1200])
        return response['result']

    def asks(where='true', values=()):
        return f.sql('SELECT id::text,kind,title,body,options,recommended,default_policy,round(extract(epoch FROM deadline-raised_at))::int AS deadline_s,chain,task::text,attempt::text,session::text,sandbox::text,raised_by::text,state '
                     'FROM hyperfide.asks WHERE ' + where + ' ORDER BY raised_at,id', list(values))

    def deliveries(ask_id):
        return f.sql("SELECT d.consumer_id::text AS consumer FROM hyperfide.outbox_events e JOIN hyperfide.event_deliveries d ON d.event_id=e.id WHERE e.aggregate_type='ask' AND e.aggregate_id=$1", [ask_id])

    def refused_without_channel():
        response = observe('claude', CLAUDE_EVENT)
        expect(response.get('ok') is False and 'ASK_OPERATOR_CONSUMER_REQUIRED' in json.dumps(response), 'a native question was accepted with no operator channel: ' + json.dumps(response)[:800])
        expect(asks() == [] and f.sql('SELECT count(*)::int AS n FROM hyperfide.native_session_events')[0]['n'] == 0, 'a refused observation left an Ask or an event behind')
    check('raise.refused-without-operator-channel', refused_without_channel)

    i['operator_consumer'] = uid()
    check('operator-channel.registered', lambda: ok(f.invoke('outbox.consumer.register', {'organisation_id': o, 'run_id': r, 'id': i['operator_consumer'], 'consumer_key': 'operator:asks',
                                                                                         'critical': False, 'state': 'ACTIVE'}, component='6.1')[1], 'register operator:asks'))
    seen = {}

    def claude_question():
        operation = uid()
        result = ok(observe('claude', CLAUDE_EVENT, operation), 'Claude AskUserQuestion observe')
        seen['claude_operation'], seen['claude_result'] = operation, result
        expect(result['kind'] == 'ADMISSION_OBSERVATION' and result['reported'] is False and result['classification']['signal'] == 'QUESTION', 'not observed as a question: ' + json.dumps(result)[:800])
        expect(len(result['asks']) == 2 and all(a['kind'] == 'question' and a['default_policy'] == 'proceed-and-flag' and a['state'] == 'OPEN' for a in result['asks']), 'Asks not raised: ' + json.dumps(result))
        expect('migration strategy' not in json.dumps(result), 'the admission evidence kept native text')
        rows = asks('session=$1', [i['claude']['session']])
        expect(len(rows) == 2, 'expected two Ask rows for the two questions: ' + json.dumps(rows)[:800])
        first, second = rows
        c = i['claude']
        expect(first['body'].startswith(CLAUDE_QUESTIONS[0]['question']) and 'Take an exclusive lock for the rewrite.' in first['body'] and first['title'] == 'Migration: ' + CLAUDE_QUESTIONS[0]['question'], 'question text not preserved: ' + json.dumps(first))
        expect(first['options'] == ['Online copy (Recommended)', 'Lock and rewrite'] and first['recommended'] == 'Online copy (Recommended)', 'options not parsed from the event: ' + json.dumps(first))
        expect(second['options'] == ['eu-west', 'us-east'] and second['recommended'] == 'eu-west' and second['body'].startswith(CLAUDE_QUESTIONS[1]['question']), 'second question wrong: ' + json.dumps(second))
        for row in rows:
            expect(row['kind'] == 'question' and row['default_policy'] == 'proceed-and-flag' and follows_policy(row) and row['state'] == 'OPEN', 'question policy not from the kind: ' + json.dumps(row))
            expect(row['task'] == c['task'] and row['attempt'] == c['attempt'] and row['session'] == c['session'] and row['sandbox'] == i['sandbox'] and row['raised_by'] == i['operator'],
                   'Ask not attributed to the observed session: ' + json.dumps(row))
            expect([d['consumer'] for d in deliveries(row['id'])] == [i['operator_consumer']], 'ask.raised not delivered to the operator consumer')
        reservation = f.sql('SELECT state FROM hyperfide.agent_admission_reservations WHERE id=$1', [c['reservation']])[0]['state']
        expect(reservation == 'RESERVED', 'a question changed admission: ' + reservation)
    check('claude.ask-user-question-raises-asks', claude_question)

    def claude_replays():
        again = ok(observe('claude', CLAUDE_EVENT, seen['claude_operation']), 'operation replay')
        expect(again == seen['claude_result'], 'operation replay changed the result')
        control = ok(observe('claude', CLAUDE_CONTROL), 'can_use_tool AskUserQuestion observe')
        expect(control['classification']['signal'] == 'QUESTION' and all(a['replayed'] for a in control['asks']) and
               [a['ask_id'] for a in control['asks']] == [a['ask_id'] for a in seen['claude_result']['asks']], 'the same native prompt raised a second Ask: ' + json.dumps(control))
        expect(len(asks('session=$1', [i['claude']['session']])) == 2, 'replays added Ask rows')
    check('claude.one-ask-per-native-prompt', claude_replays)

    def codex_question():
        result = ok(observe('codex', CODEX_EVENT), 'Codex requestUserInput observe')
        expect(result['classification']['signal'] == 'QUESTION' and result['classification']['code'] == 'item/tool/requestUserInput' and result['reported'] is False, json.dumps(result)[:800])
        rows = asks('session=$1', [i['codex']['session']])
        expect([row['kind'] for row in rows] == ['question', 'secret'], 'Codex Ask kinds wrong: ' + json.dumps(rows)[:800])
        q, secret = rows
        expect(q['options'] == ['staging', 'production'] and q['recommended'] == 'staging' and q['default_policy'] == 'proceed-and-flag' and follows_policy(q)
               and q['body'].startswith('Which environment should the smoke test run against?') and 'Shared staging cluster.' in q['body'] and q['title'] == 'Target: Which environment should the smoke test run against?', json.dumps(q))
        expect(secret['default_policy'] == 'block' and follows_policy(secret) and secret['options'] == [] and secret['recommended'] is None
               and 'Paste the deploy token for the staging cluster.' in secret['body'], 'a secret question may not proceed by default: ' + json.dumps(secret))
        expect(all(row['task'] == i['codex']['task'] and row['attempt'] == i['codex']['attempt'] for row in rows), 'Codex Asks not attributed to its attempt')
    check('codex.request-user-input-raises-asks', codex_question)

    def approval():
        result = ok(observe('claude', CLAUDE_APPROVAL, refs=True), 'Claude can_use_tool observe')
        expect(result['reported'] is True and result['reported_reason'] == 'APPROVAL_REQUIRED' and result['reservation']['state'] == 'ESCALATED', 'approval not escalated: ' + json.dumps(result)[:800])
        expect(len(result['asks']) == 1 and result['asks'][0]['kind'] == 'permission' and result['asks'][0]['default_policy'] == 'block', json.dumps(result['asks']))
        expect('rm -rf' not in json.dumps(result), 'the admission evidence kept the native command')
        row = asks('id=$1', [result['asks'][0]['ask_id']])[0]
        expect(row['title'] == 'Claude asks to use Bash' and 'rm -rf build/ && make release' in row['body'] and row['options'] == ['deny', 'approve'] and row['recommended'] == 'deny'
               and row['kind'] == 'permission' and follows_policy(row) and row['session'] == i['claude']['session'], 'permission Ask wrong: ' + json.dumps(row))
    check('approval.permission-ask-and-escalation', approval)

    def nothing_else():
        before = len(asks())
        ignored = ok(observe('codex', {'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': 'Which environment?'}}}), 'ignored observe')
        expect(ignored['asks'] == [] and len(asks()) == before == 5, 'an ordinary message raised an Ask, or the Ask count is wrong: %d' % before)
    check('negative.ordinary-message-raises-nothing', nothing_else)

    def connector_bound():
        before = len(asks())
        response = f.invoke('agent.admission.observe', {
            'scope': {'organisation_id': o, 'run_id': r, 'session_id': i['codex']['session']}, 'reservation_id': i['codex']['reservation'],
            'operation_id': uid(), 'connector': 'claude', 'event': CLAUDE_EVENT}, key='operator', component='13.4')[1]
        expect(response.get('ok') is False and 'ADMISSION_SIGNAL_CONNECTOR_MISMATCH' in json.dumps(response), 'a Claude question was accepted on a Codex reservation: ' + json.dumps(response)[:600])
        expect(len(asks()) == before, 'a refused observation raised an Ask')
    check('negative.connector-bound', connector_bound)


def main():
    t27 = load('hf_case_v21_2_7', 'tests/hyperfide/cases/v21/2_7.py')
    binaries = t27.postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        skip('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    if os.geteuid() != 0 or shutil.which('runuser') is None:
        skip('owned cluster needs root and runuser to start PostgreSQL as the postgres user')
    try:
        pwd.getpwnam('postgres')
    except KeyError:
        skip('no postgres system user for the owned cluster')
    stamp = subprocess.run(['node', str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(SERVICE)], cwd=ROOT, capture_output=True, text=True)
    if stamp.returncode:
        build = subprocess.run(['npm', '--prefix', str(SERVICE), 'run', 'build'], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if build.returncode:
            print('service build failed: ' + (build.stderr + build.stdout)[-1500:], file=sys.stderr)
            return 1
    classifier_checks()
    # Only the owned cluster is reachable: never let an inherited database URL redirect the probe.
    for key in [k for k in os.environ if k == 'DATABASE_URL' or k.startswith('HYPERFIDE_') and k.endswith('_DATABASE_URL')]:
        del os.environ[key]
    cluster, fixture, closed = None, None, False
    try:
        cluster = t27.Cluster(binaries)
        cluster.migrate_template()
        os.environ['DATABASE_URL'] = cluster.url()
        import identity_fixture
        for attempt in range(3):
            try:
                fixture = identity_fixture.IdentityFixture(extra_components=COMPONENTS, extra_setup=setup)
                break
            except AssertionError as error:
                if 'TX_TIMEOUT' not in str(error) or attempt == 2:
                    raise
        scenario(fixture)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        FAILED.append('setup')
    finally:
        try:
            if fixture:
                fixture.close()
            if cluster:
                cluster.close()
            closed = cluster is not None and not cluster.root.exists()
        except Exception as error:
            print('cleanup failed: ' + str(error), file=sys.stderr)
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'status': 'deleted' if closed else 'unknown', 'observed_absent': closed}],
                      'complete': closed}), flush=True)
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
