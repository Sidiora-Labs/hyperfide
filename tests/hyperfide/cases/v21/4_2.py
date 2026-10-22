#!/usr/bin/env python3
"""hyperfide-v21 4.2: native events leave the sandbox and become Ask rows.

The launch broker (src/hyperfide/launch.c, proven by tests/integration/101_launch_events.sh) forwards each native
question or approval prompt line out of the sandbox as a native.question / native.approval launch event and posts it
to 12.2 runner.launch.event.record. This case drives that handler through the real HTTPS control service, as the
enrolled RUNNER of the sandbox boot, with payloads in exactly the broker's shape, on an owned throwaway PostgreSQL
cluster (the v21/4_1.py pattern). It asserts that a Claude Code AskUserQuestion and a Codex item/tool/requestUserInput
inside a launched process become Ask rows attributed to the launch's session, attempt, task and sandbox; that approvals
become permission Asks; that ordinary launch events are recorded without Asks; that replays and the same prompt by a
second path raise no second Ask; and that foreign launches, sessions, sequences and callers are refused. Supervision
inspect (13.4-supervision) is driven against a stand-in supervisory host socket whose frames carry an AskUserQuestion.

No codex CLI is installed on this host: both native shapes are recorded protocol fixtures (Claude Code stream-json,
Codex app-server JSON-RPC). Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import hashlib, importlib.util, json, os, re, pathlib, pwd, shutil, socket, subprocess, sys, threading, traceback, uuid, base64

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
COMPONENTS = ('2.1', '2.4', '3.1', '3.2', '5.1', '5.2', '6.1', '6.2', '6.3', '7.2', '7.3', '1.2-asks', '12.2', '1.1', '14.2', '14.3', '13.4-supervision')
DIGEST = 'sha256:' + 'a' * 64
# Key set of the payload launch.c queue_event writes (and tasks/12_2.py's coordinator checks).
LAUNCH_FIELDS = {'schema_version', 'event_id', 'organisation_id', 'run_id', 'sandbox_id', 'boot_id', 'sandbox_boot_generation', 'launch_id', 'command_id',
                 'sequence', 'kind', 'observed_at_seconds', 'data'}

CLAUDE_QUESTIONS = [
    {'question': 'Which migration strategy should the worker use for the orders table?', 'header': 'Migration',
     'options': [{'label': 'Online copy (Recommended)', 'description': 'Copy rows in batches while writes continue.'},
                 {'label': 'Lock and rewrite', 'description': 'Take an exclusive lock for the rewrite.'}], 'multiSelect': False},
    {'question': 'Which regions should receive the canary?', 'header': 'Regions',
     'options': [{'label': 'eu-west', 'description': 'Primary EU region.'}, {'label': 'us-east', 'description': 'Primary US region.'}], 'multiSelect': True},
]
CLAUDE_EVENT = {'type': 'assistant', 'message': {'id': 'msg_1', 'role': 'assistant', 'content': [
    {'type': 'text', 'text': 'I need a decision before continuing.'},
    {'type': 'tool_use', 'id': 'toolu_01AskQ', 'name': 'AskUserQuestion', 'input': {'questions': CLAUDE_QUESTIONS}}]}, 'session_id': 'native-claude'}
CLAUDE_CONTROL = {'type': 'control_request', 'request_id': 'req-7', 'request': {'subtype': 'can_use_tool', 'tool_name': 'AskUserQuestion',
                                                                               'tool_use_id': 'toolu_01AskQ', 'input': {'questions': CLAUDE_QUESTIONS}}}
CODEX_EVENT = {'id': 41, 'method': 'item/tool/requestUserInput', 'params': {'threadId': 'thr_1', 'turnId': 'turn_1', 'itemId': 'call_ui_9', 'questions': [
    {'id': 'deploy_target', 'header': 'Target', 'question': 'Which environment should the smoke test run against?', 'isOther': True, 'isSecret': False,
     'options': [{'label': 'staging', 'description': 'Shared staging cluster.'}, {'label': 'production', 'description': 'Live traffic.'}]},
    {'id': 'api_token', 'header': 'Token', 'question': 'Paste the deploy token for the staging cluster.', 'isOther': False, 'isSecret': True, 'options': None}]}}
CODEX_APPROVAL = {'id': 42, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': 'thr_1', 'turnId': 'turn_1', 'itemId': 'call_cmd_3',
                                                                                         'command': 'make deploy', 'cwd': '/work', 'reason': 'network access'}}
SUPERVISOR_QUESTION = {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'toolu_sup_1', 'name': 'AskUserQuestion', 'input': {'questions': [
    {'question': 'Should the wave-5 package start before 4.9 merges?', 'header': 'Order',
     'options': [{'label': 'Wait for 4.9 (Recommended)', 'description': 'Keep the merge order.'}, {'label': 'Start now', 'description': 'Accept a rebase.'}]}]}}]}}


def uid():
    return str(uuid.uuid4())


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


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
    print(json.dumps({'type': 'assertion', 'id': 'launch-event.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SupervisoryHost:
    """Stand-in for the supervisory host's JSON-line socket: inspect returns the stdout frames after a sequence."""
    def __init__(self, path, launch_id, data):
        self.path, self.launch_id, self.frames = str(path), launch_id, []
        for n, start in enumerate(range(0, len(data), 1500)):
            chunk = data[start:start + 1500]
            self.frames.append({'sequence': str(n + 1), 'stream': 'stdout', 'frame_digest': sha(chunk), 'frame_b64': base64.b64encode(chunk).decode()})
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        os.chmod(self.path, 0o600)
        self.server.listen(8)
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with client:
                pending = b''
                while not pending.endswith(b'\n'):
                    data = client.recv(65536)
                    if not data:
                        break
                    pending += data
                request = json.loads(pending)
                after = int(request.get('after_sequence', '0'))
                result = {'launch_id': self.launch_id, 'frames': [f for f in self.frames if int(f['sequence']) > after][:64], 'output_truncated': False,
                          'process_identity': None, 'state': 'RUNNING', 'exit_code': None}
                client.sendall(json.dumps({'ok': True, 'result': result}).encode() + b'\n')

    def close(self):
        self.server.close()


def setup(f):
    """A Claude and a Codex worker, each on its own attempt with a committed START naming its launch, plus a supervision launch."""
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    for key in ('package', 'leader'):
        i[key] = uid()
    f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'launch-events',4)", [o, r, i['package']])
    f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES($1,$2,$3,'LEADER','claude','fixture','native-leader','RUNNING')", [o, r, i['leader']])
    for connector in ('claude', 'codex'):
        t, slot, attempt, session, launch, command = uid(), uid(), uid(), uid(), uid(), uid()
        i[connector] = {'task': t, 'slot': slot, 'attempt': attempt, 'session': session, 'launch': launch, 'command': command}
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',4)",
              [o, r, t, '4.2-' + connector, i['package'], i['spec'], DIGEST])
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,$4,1,'AGENT')", [o, slot, i['sandbox'], 'launch-' + connector])
        f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) "
              "VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '30 minutes')", [o, r, attempt, t, i['epoch'], DIGEST, i['sandbox'], slot])
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) "
              "VALUES($1,$2,$3,'WORKER',$4,$5,'fixture',$6,$7,$8,1,$9,'RUNNING')", [o, r, session, i['leader'], connector, 'native-' + connector, slot, i['sandbox'], attempt])
        payload = {'instruction_id': command, 'attempt_id': attempt, 'attempt_generation': '1', 'authority_epoch': i['epoch'], 'sandbox_boot_generation': '1', 'kind': 'START',
                   'body': {'launch_id': launch, 'slot_id': slot, 'agent_session_id': session, 'connector_plan_digest': DIGEST}, 'sandbox_id': i['sandbox'], 'boot_id': i['boot']}
        f.sql("INSERT INTO hyperfide.outbox_events(organisation_id,run_id,id,aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,'attempt.instructions',$4,1,'instruction.start',$5::jsonb)",
              [o, r, command, attempt, json.dumps(payload)])
    i['supervisor_launch'] = uid()
    f.sql("INSERT INTO hyperfide.supervisor_launches(organisation_id,run_id,id,session_id,profile_id,profile_digest,request_digest,host_id,placement,reservations,state) "
          "VALUES($1,$2,$3,$4,'fixture-supervision',$5,$5,'fixture-host','{}'::jsonb,'[]'::jsonb,'RUNNING')", [o, r, i['supervisor_launch'], i['leader'], DIGEST])
    # 14.3 and 14.2 (required by 13.4-supervision) load pinned profiles and the credential store at startup.
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
    lines = (json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Reviewing the frontier.'}]}}) + '\n' + json.dumps(SUPERVISOR_QUESTION) + '\n').encode()
    f.host = SupervisoryHost(f.path / 'host.sock', i['supervisor_launch'], lines)
    f.env['HYPERFIDE_SUPERVISORY_HOST_SOCKET'] = str(f.path / 'host.sock')


def scenario(f):
    i = f.ids
    o, r = i['organisation'], i['run']
    sequences = {}

    def event(connector, kind, data, sequence=None, launch=None, command='start', event_id=None, **override):
        w = i[connector]
        launch = launch or w['launch']
        if sequence is None:
            sequences[launch] = sequences.get(launch, 0) + 1
            sequence = sequences[launch]
        value = {'schema_version': 1, 'event_id': event_id or uid(), 'organisation_id': o, 'run_id': r, 'sandbox_id': i['sandbox'], 'boot_id': i['boot'],
                 'sandbox_boot_generation': '1', 'launch_id': launch, 'command_id': w['command'] if command == 'start' else command, 'sequence': str(sequence),
                 'kind': kind, 'observed_at_seconds': 1792000000, 'data': data}
        value.update(override)
        return value

    def native(connector, event_value, kind=None, session=None):
        signal = 'QUESTION' if kind != 'native.approval' else 'APPROVAL_PROMPT'
        return {'connector': connector, 'agent_session_id': session or i[connector]['session'], 'signal': signal, 'event': event_value}

    def record(value, key='runner'):
        expect(set(value) == LAUNCH_FIELDS or key != 'runner' or 'extra' in value, 'payload drifted from the broker shape')
        credential = i['runner'] if key == 'runner' else None
        return f.invoke('runner.launch.event.record', value, component='12.2', key=key, credential=credential)[1]

    def ok(response, label):
        expect(response.get('ok') is True, label + ' failed: ' + json.dumps(response)[:1200])
        return response['result']

    def refused(response, code, label):
        expect(response.get('ok') is False and code in json.dumps(response), label + ' was not refused with ' + code + ': ' + json.dumps(response)[:800])

    def asks(where='true', values=()):
        return f.sql('SELECT id::text,kind,title,body,options,recommended,default_policy,round(extract(epoch FROM deadline-raised_at))::int AS deadline_s,chain,task::text,attempt::text,session::text,sandbox::text,raised_by::text,state '
                     'FROM hyperfide.asks WHERE ' + where + ' ORDER BY raised_at,id', list(values))

    def recorded(event_id):
        return f.sql("SELECT count(*)::int AS n FROM hyperfide.command_inbox WHERE operation='runner.launch-event' AND idempotency_key=$1", [event_id])[0]['n']

    def deliveries(ask_id):
        return f.sql("SELECT d.consumer_id::text AS consumer FROM hyperfide.outbox_events e JOIN hyperfide.event_deliveries d ON d.event_id=e.id WHERE e.aggregate_type='ask' AND e.aggregate_id=$1", [ask_id])

    check('runner.enrolled', lambda: f.bootstrap_runner())

    def no_channel():
        value = event('claude', 'native.question', native('claude', CLAUDE_EVENT))
        refused(record(value), 'ASK_OPERATOR_CONSUMER_REQUIRED', 'a native question with no operator channel')
        expect(asks() == [] and recorded(value['event_id']) == 0, 'a refused event was recorded or raised an Ask; the broker must retry it')
        sequences[i['claude']['launch']] -= 1
    check('raise.refused-without-operator-channel', no_channel)

    i['operator_consumer'] = uid()
    check('operator-channel.registered', lambda: ok(f.invoke('outbox.consumer.register', {'organisation_id': o, 'run_id': r, 'id': i['operator_consumer'], 'consumer_key': 'operator:asks',
                                                                                         'critical': False, 'state': 'BUFFERING'}, component='6.1')[1], 'register operator:asks'))
    seen = {}

    def ordinary():
        value = event('claude', 'launch.running', {'state': 'RUNNING', 'agent_session_id': i['claude']['session']})
        result = ok(record(value), 'launch.running')
        expect(result['recorded'] is True and result['event_id'] == value['event_id'] and result['asks'] == [] and result['signal'] is None and result['replayed'] is False, json.dumps(result))
        expect(asks() == [], 'an ordinary launch event raised an Ask')
        terminal = event('codex', 'launch.terminal', {'state': 'EXITED'}, command=None)
        expect(ok(record(terminal), 'command-less event')['recorded'] is True, 'an event without a command was not recorded')
    check('ordinary.recorded-without-asks', ordinary)

    def claude_question():
        value = event('claude', 'native.question', native('claude', CLAUDE_EVENT))
        result = ok(record(value), 'Claude AskUserQuestion')
        seen['claude'], seen['claude_value'] = result, value
        w = i['claude']
        expect(result['recorded'] is True and result['event_id'] == value['event_id'] and result['signal'] == 'QUESTION' and result['agent_session_id'] == w['session']
               and result['attempt_id'] == w['attempt'] and len(result['asks']) == 2, 'not recorded as a question: ' + json.dumps(result)[:1000])
        rows = asks('session=$1', [w['session']])
        expect(len(rows) == 2, 'expected an Ask row per question: ' + json.dumps(rows)[:800])
        first, second = rows
        expect(first['title'] == 'Migration: ' + CLAUDE_QUESTIONS[0]['question'] and first['body'].startswith(CLAUDE_QUESTIONS[0]['question'])
               and first['options'] == ['Online copy (Recommended)', 'Lock and rewrite'] and first['recommended'] == 'Online copy (Recommended)', 'question text or options lost: ' + json.dumps(first))
        expect(second['options'] == ['eu-west', 'us-east'], json.dumps(second))
        for row in rows:
            expect(row['kind'] == 'question' and row['default_policy'] == 'proceed-and-flag' and row['deadline_s'] == 3600 and row['chain'] == ['leader', 'operator'] and row['state'] == 'OPEN', json.dumps(row))
            expect(row['task'] == w['task'] and row['attempt'] == w['attempt'] and row['session'] == w['session'] and row['sandbox'] == i['sandbox'] and row['raised_by'] == i['runner'],
                   'Ask not attributed to the launch: ' + json.dumps(row))
            expect([d['consumer'] for d in deliveries(row['id'])] == [i['operator_consumer']], 'ask.raised not delivered to the operator')
    check('claude.ask-user-question-becomes-ask-rows', claude_question)

    def replays():
        again = ok(record(seen['claude_value']), 'broker replay')
        expect(again['replayed'] is True and again['asks'] == seen['claude']['asks'] and again['event_id'] == seen['claude_value']['event_id'], 'a broker replay changed the record: ' + json.dumps(again)[:800])
        control = ok(record(event('claude', 'native.question', native('claude', CLAUDE_CONTROL))), 'can_use_tool AskUserQuestion')
        expect(all(a['replayed'] for a in control['asks']) and [a['ask_id'] for a in control['asks']] == [a['ask_id'] for a in seen['claude']['asks']],
               'the same prompt by its control request raised a second Ask: ' + json.dumps(control)[:800])
        expect(len(asks('session=$1', [i['claude']['session']])) == 2, 'replays added Ask rows')
    check('claude.one-ask-per-native-prompt', replays)

    def codex_question():
        result = ok(record(event('codex', 'native.question', native('codex', CODEX_EVENT))), 'Codex requestUserInput')
        expect(result['signal'] == 'QUESTION' and len(result['asks']) == 2, json.dumps(result)[:800])
        rows = asks('session=$1', [i['codex']['session']])
        expect([row['kind'] for row in rows] == ['question', 'secret'], 'Codex Ask kinds wrong: ' + json.dumps(rows)[:800])
        q, secret = rows
        expect(q['options'] == ['staging', 'production'] and q['recommended'] == 'staging' and q['title'] == 'Target: Which environment should the smoke test run against?', json.dumps(q))
        expect(secret['default_policy'] == 'block' and secret['chain'] == ['operator'] and secret['options'] == [] and 'Paste the deploy token' in secret['body'], json.dumps(secret))
        expect(all(row['attempt'] == i['codex']['attempt'] and row['task'] == i['codex']['task'] and row['sandbox'] == i['sandbox'] for row in rows), 'Codex Asks not attributed')
    check('codex.request-user-input-becomes-ask-rows', codex_question)

    def codex_approval():
        result = ok(record(event('codex', 'native.approval', native('codex', CODEX_APPROVAL, 'native.approval'))), 'Codex approval')
        expect(result['signal'] == 'APPROVAL_PROMPT' and len(result['asks']) == 1 and result['asks'][0]['kind'] == 'permission', json.dumps(result)[:800])
        row = asks('id=$1', [result['asks'][0]['ask_id']])[0]
        expect(row['title'] == 'Codex asks to run a command' and 'make deploy' in row['body'] and row['options'] == ['deny', 'approve'] and row['recommended'] == 'deny'
               and row['default_policy'] == 'block' and row['session'] == i['codex']['session'], json.dumps(row))
    check('codex.approval-becomes-permission-ask', codex_approval)

    def unreadable():
        before = len(asks())
        result = ok(record(event('codex', 'native.question', native('codex', {'id': 9, 'method': 7}))), 'unclassifiable native line')
        expect(result['signal'] == 'UNCLASSIFIED' and result['asks'] == [] and len(asks()) == before, 'an unreadable line was refused or raised an Ask; refusing would wedge the spool')
    check('native.unreadable-recorded-not-refused', unreadable)

    def oversize():
        before = len(asks())
        data = {'connector': 'claude', 'agent_session_id': i['claude']['session'], 'signal': 'QUESTION', 'bytes': '70000', 'complete': True, 'digest': DIGEST}
        result = ok(record(event('claude', 'native.oversize', data)), 'native.oversize')
        expect(result['recorded'] is True and result['asks'] == [] and len(asks()) == before, 'an oversize report raised an Ask or was refused: ' + json.dumps(result)[:600])
    check('native.oversize-recorded-by-digest', oversize)

    def broker_shape():
        source = (ROOT / 'src/hyperfide/launch.c').read_text()
        start = source.index(r'{\"schema_version\":1')
        written = source[start:source.index(r'\"data\":%s}', start) + 12]
        keys = set(re.findall(r'\\"([a-z_]+)\\":', written))
        expect(keys == LAUNCH_FIELDS, 'launch.c queue_event keys drifted from this case: ' + repr(sorted(keys ^ LAUNCH_FIELDS)))
    check('broker.payload-shape-matches-launch-c', broker_shape)

    def refusals():
        before = len(asks())
        base = event('claude', 'native.question', native('claude', CLAUDE_CONTROL))
        refused(record(dict(base, data=native('claude', CLAUDE_EVENT, session=uid()))), 'AUTH_SCOPE_DENIED', 'another session')
        refused(record(dict(base, launch_id=uid())), 'RUNNER_EVENT_LAUNCH_UNKNOWN', 'a launch the START does not name')
        refused(record(dict(base, command_id=i['codex']['command'])), 'RUNNER_EVENT_LAUNCH_UNKNOWN', 'another launch\'s START')
        refused(record(dict(base, command_id=None)), 'EVENT_INPUT_INVALID', 'a native event without its START')
        refused(record(dict(base, sandbox_id=uid())), 'AUTH_SCOPE_DENIED', 'another sandbox')
        refused(record(dict(base, data=dict(base['data'], connector='gemini'))), 'EVENT_INPUT_INVALID', 'an unknown connector')
        refused(record(dict(base, sequence='1')), 'RUNNER_EVENT_SEQUENCE_CONFLICT', 'a reused launch sequence')
        refused(record(dict(seen['claude_value'], observed_at_seconds=1)), 'RUNNER_EVENT_CONFLICT', 'a reused event id with other contents')
        operator = f.invoke('runner.launch.event.record', base, component='12.2', key='operator')[1]
        expect(operator.get('ok') is False and recorded(base['event_id']) == 0, 'an operator posted a runner launch event: ' + json.dumps(operator)[:600])
        expect(len(asks()) == before, 'a refused event raised an Ask')
    check('negative.foreign-and-conflicting-events-refused', refusals)

    def supervision():
        before = len(asks())
        result = ok(f.invoke('supervisor.session.inspect', {'launch_id': i['supervisor_launch']}, component='13.4.supervision')[1], 'supervision inspect')
        expect(len(result['asks']) == 1 and result['asks'][0]['kind'] == 'question', 'supervision AskUserQuestion not raised: ' + json.dumps(result)[:800])
        row = asks('id=$1', [result['asks'][0]['ask_id']])[0]
        expect(row['session'] == i['leader'] and row['attempt'] is None and row['sandbox'] is None and row['raised_by'] == i['operator'] and
               row['options'] == ['Wait for 4.9 (Recommended)', 'Start now'] and row['title'].startswith('Order: Should the wave-5 package'), json.dumps(row))
        again = ok(f.invoke('supervisor.session.inspect', {'launch_id': i['supervisor_launch']}, component='13.4.supervision')[1], 'second inspect')
        expect(again['asks'] == [] and len(asks()) == before + 1, 'a re-inspection raised the prompt again')
    check('supervision.inspect-raises-ask', supervision)


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
                fixture = identity_fixture.IdentityFixture(extra_components=COMPONENTS, extra_env={'HF_SCHEDULER_NATIVE_CONSUMER_ID': uid()}, extra_setup=setup)
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
                if getattr(fixture, 'host', None):
                    fixture.host.close()
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
