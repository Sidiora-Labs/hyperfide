#!/usr/bin/env python3
"""hyperfide-v21 4.4: answers reach the agent.

A worker's Ask (raised from a native question by v21/4.2) is answered through human.ask.answer, or decided by default
at its deadline through human.ask.sweep, and 6.3 instructions.answer.deliver queues the answer as a STEER on the asking
attempt, bound to that attempt's START launch: one native input frame (Claude Code stream-json user message, Codex
app-server turn/start) that the enrolled RUNNER of the sandbox boot polls and launch.c writes to the agent's stdin.
A leader's own Ask is answered through 13.4 supervisor.session.answer, which is supervisor.session.input under every
one of its guards. Runs through the real HTTPS control service on an owned throwaway PostgreSQL cluster (the v21/4_2.py
pattern). The flat-run re-wake of a -p worker that made no edits while blocked is proven by
tests/integration/92_answer_rewake.sh.

No codex CLI is installed on this host: the Codex question and the Codex input frame are recorded protocol fixtures
(Codex app-server JSON-RPC). No native profile can qualify here (14.3 reports UNQUALIFIED), so the leader delivery is
proven to take the input path and stop at the same guard supervisor.session.input stops at, not to reach a process.
Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import base64, importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
COMPONENTS = ('2.1', '2.4', '3.1', '3.2', '5.1', '5.2', '6.1', '6.2', '6.3', '7.2', '7.3', '1.2-asks', '12.2', '1.1', '14.2', '14.3', '13.4-supervision')
DIGEST = 'sha256:' + 'a' * 64
FRAME_BYTES = 4096


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


T42 = load('hf_case_v21_4_2_fixtures', 'tests/hyperfide/cases/v21/4_2.py')


def uid():
    return str(uuid.uuid4())


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
    print(json.dumps({'type': 'assertion', 'id': 'answer.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def unb64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def setup(f):
    """A Claude and a Codex worker on live attempts (current task generation, ACTIVE compute lease), a leader with a
    supervision launch. The STARTs are written after the runner binds its consumer (an empty native history)."""
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    for key in ('package', 'leader'):
        i[key] = uid()
    f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'answers',4)", [o, r, i['package']])
    f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES($1,$2,$3,'LEADER','claude','fixture','native-leader','RUNNING')", [o, r, i['leader']])
    for connector in ('claude', 'codex'):
        t, slot, attempt, session, launch, command = uid(), uid(), uid(), uid(), uid(), uid()
        i[connector] = {'task': t, 'slot': slot, 'attempt': attempt, 'session': session, 'launch': launch, 'command': command}
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',4)",
              [o, r, t, '4.4-' + connector, i['package'], i['spec'], DIGEST])
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,$4,1,'AGENT')", [o, slot, i['sandbox'], 'answer-' + connector])
        f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) "
              "VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '30 minutes')", [o, r, attempt, t, i['epoch'], DIGEST, i['sandbox'], slot])
        f.sql("UPDATE hyperfide.tasks SET generation=1,current_attempt_id=$3,state='RUNNING',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$4", [o, r, attempt, t])
        f.sql("INSERT INTO hyperfide.compute_leases(organisation_id,run_id,id,attempt_id,attempt_generation,authority_epoch,sandbox_boot_generation,expires_at) VALUES($1,$2,$3,$4,1,$5,1,clock_timestamp()+interval '30 minutes')",
              [o, r, uid(), attempt, i['epoch']])
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) "
              "VALUES($1,$2,$3,'WORKER',$4,$5,'fixture',$6,$7,$8,1,$9,'RUNNING')", [o, r, session, i['leader'], connector, 'native-' + connector, slot, i['sandbox'], attempt])
    i['supervisor_launch'] = uid()
    f.sql("INSERT INTO hyperfide.supervisor_launches(organisation_id,run_id,id,session_id,profile_id,profile_digest,request_digest,host_id,placement,reservations,state) "
          "VALUES($1,$2,$3,$4,'fixture-native',$5,$5,'fixture-host','{}'::jsonb,'[]'::jsonb,'RUNNING')", [o, r, i['supervisor_launch'], i['leader'], DIGEST])
    # 14.3/14.2 (required by 13.4-supervision) and the stand-in supervisory host, as v21/4_2.py sets them up.
    binary = pathlib.Path(os.path.realpath(shutil.which('true') or '/bin/true'))
    home = f.path / 'native-home'
    home.mkdir(mode=0o700)
    os.chown(home, 1001, 1001)
    profile = {'schema_version': 1, 'profile_id': 'fixture-native', 'profile_revision': '1', 'connector': 'claude', 'auth_mode': 'account_session',
               'binary': {'path': str(binary), 'digest': T42.sha(binary.read_bytes()), 'version': '1.0.0'}, 'credential_reference': 'fixture-reference',
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
    lines = (json.dumps(T42.SUPERVISOR_QUESTION) + '\n').encode()
    f.host = T42.SupervisoryHost(f.path / 'host.sock', i['supervisor_launch'], lines)
    f.env['HYPERFIDE_SUPERVISORY_HOST_SOCKET'] = str(f.path / 'host.sock')


def scenario(f):
    i = f.ids
    o, r = i['organisation'], i['run']
    s = {'organisation_id': o, 'run_id': r}
    seq = {}

    def ok(response, label):
        expect(response.get('ok') is True, label + ' failed: ' + json.dumps(response)[:1200])
        return response['result']

    def refused(response, code, label):
        expect(response.get('ok') is False and code in json.dumps(response), label + ' was not refused with ' + code + ': ' + json.dumps(response)[:800])

    def call(action, value, component, key='operator'):
        credential = i['runner'] if key == 'runner' else None
        return f.invoke(action, value, component=component, key=key, credential=credential)[1]

    def native(connector, line):
        w = i[connector]
        seq[connector] = seq.get(connector, 0) + 1
        value = {'schema_version': 1, 'event_id': uid(), 'organisation_id': o, 'run_id': r, 'sandbox_id': i['sandbox'], 'boot_id': i['boot'],
                 'sandbox_boot_generation': '1', 'launch_id': w['launch'], 'command_id': w['command'], 'sequence': str(seq[connector]),
                 'kind': 'native.question', 'observed_at_seconds': 1792000000,
                 'data': {'connector': connector, 'agent_session_id': w['session'], 'signal': 'QUESTION', 'event': line}}
        return ok(call('runner.launch.event.record', value, '12.2', 'runner'), connector + ' native question')['asks']

    def ask(ask_id):
        return f.sql('SELECT id::text,kind,state,state_version::text,answer,decided_by_default,attempt::text,session::text FROM hyperfide.asks WHERE id=$1', [ask_id])[0]

    def seed_ask(connector, kind, policy, options, recommended, title, past):
        # A row exactly as 1.2 raises it, raised two hours ago; a past deadline lets the sweep take it now.
        w = i[connector]
        return f.sql("INSERT INTO hyperfide.asks(organisation_id,run_id,kind,title,options,recommended,deadline,default_policy,chain,task,attempt,session,sandbox,raised_by,raised_at) "
                     "VALUES($1,$2,$3,$4,$5::jsonb,$6,CASE WHEN $7 THEN clock_timestamp()-interval '1 hour' END,$8,'[\"operator\"]'::jsonb,$9,$10,$11,$12,$13,clock_timestamp()-interval '2 hours') RETURNING id::text",
                     [o, r, kind, title, json.dumps(options), recommended, past, policy, w['task'], w['attempt'], w['session'], i['sandbox'], i['runner']])[0]['id']

    def answer(ask_id, text):
        return ok(call('human.ask.answer', {'ask_id': ask_id, 'expected_state_version': ask(ask_id)['state_version'], 'answer': text}, '1.2-asks'), 'answer ' + ask_id)

    def deliver(ask_id, key='operator'):
        return call('instructions.answer.deliver', dict(s, ask_id=ask_id), '6.3', key)

    def steer_row(instruction_id):
        rows = f.sql("SELECT e.event_type,e.aggregate_id::text AS attempt,e.payload,(SELECT count(*)::int FROM hyperfide.event_deliveries d WHERE d.event_id=e.id AND d.consumer_id=$2) AS to_runner "
                     "FROM hyperfide.outbox_events e WHERE e.organisation_id=$3 AND e.run_id=$4 AND e.id=$1", [instruction_id, i['runner_consumer'], o, r])
        expect(len(rows) == 1, 'no STEER outbox row for ' + instruction_id)
        return rows[0]

    def frame_of(row):
        raw = unb64url(row['payload']['body']['frame_b64'])
        expect(len(raw) <= FRAME_BYTES and raw.endswith(b'\n') and raw.count(b'\n') == 1, 'not one bounded native input line: %d bytes' % len(raw))
        return json.loads(raw)

    check('runner.enrolled', lambda: f.bootstrap_runner())
    i['runner_consumer'] = uid()

    def bind_consumer():
        ok(call('instructions.consumer.register', dict(s, consumer_id=i['runner_consumer']), '6.3', 'runner'), 'runner consumer')
        for connector in ('claude', 'codex'):
            w = i[connector]
            start = dict(s, id=w['command'], attempt_id=w['attempt'], attempt_generation='1', authority_epoch=i['epoch'], sandbox_boot_generation='1', kind='START',
                         body={'launch_id': w['launch'], 'slot_id': w['slot'], 'agent_session_id': w['session'], 'connector_plan_digest': DIGEST})
            ok(call('instructions.issue', start, '6.3'), connector + ' START')
        ok(call('outbox.consumer.register', dict(s, id=uid(), consumer_key='operator:asks', critical=False, state='BUFFERING'), '6.1'), 'operator:asks')
    check('setup.runner-consumer-and-starts', bind_consumer)

    asks = {}

    def raise_asks():
        claude = native('claude', T42.CLAUDE_EVENT)
        codex = native('codex', T42.CODEX_EVENT)
        expect(len(claude) == 2 and len(codex) == 2, 'native questions did not become Asks: ' + json.dumps([claude, codex])[:800])
        asks['claude'], asks['regions'] = claude[0]['ask_id'], claude[1]['ask_id']
        asks['codex'], asks['secret'] = codex[0]['ask_id'], codex[1]['ask_id']
        expect(ask(asks['claude'])['attempt'] == i['claude']['attempt'] and ask(asks['codex'])['attempt'] == i['codex']['attempt'], 'Asks not attributed to their attempts')
    check('setup.worker-asks-raised', raise_asks)

    def open_pending():
        refused(deliver(asks['claude']), 'ASK_ANSWER_PENDING', 'delivering an open Ask')
        refused(deliver(uid()), 'ASK_NOT_FOUND', 'delivering an unknown Ask')
    check('negative.open-ask-has-nothing-to-deliver', open_pending)

    seen = {}

    def claude_delivery():
        answer(asks['claude'], 'Lock and rewrite')
        result = ok(deliver(asks['claude']), 'Claude answer delivery')
        seen['claude'] = result
        expect(result['attempt_id'] == i['claude']['attempt'] and result['launch_id'] == i['claude']['launch'] and result['connector'] == 'claude'
               and result['delivery'] == 'QUEUED_FOR_NATIVE_INPUT' and result['grants_authority'] is False and result['decided_by_default'] is False
               and result['answer_truncated'] is False, json.dumps(result))
        row = steer_row(result['instruction_id'])
        expect(row['event_type'] == 'instruction.steer' and row['attempt'] == i['claude']['attempt'] and row['to_runner'] == 1, 'STEER not addressed to the runner consumer: ' + json.dumps(row)[:600])
        p = row['payload']
        expect(p['kind'] == 'STEER' and p['sandbox_id'] == i['sandbox'] and p['boot_id'] == i['boot'] and p['body']['launch_id'] == i['claude']['launch']
               and p['body']['request_id'] == result['request_id'] and set(p['body']) == {'launch_id', 'request_id', 'frame_b64'}, json.dumps(p)[:800])
        frame = frame_of(row)
        expect(frame['type'] == 'user' and frame['session_id'] == 'native-claude' and frame['message']['role'] == 'user', json.dumps(frame))
        text = frame['message']['content']
        expect('Answer to your Ask ' + asks['claude'] + ' (question)' in text and 'Answer: Lock and rewrite' in text and 'Migration:' in text, text)
    check('worker.claude-answer-queued-as-steer-frame', claude_delivery)

    def replay():
        again = ok(deliver(asks['claude']), 'repeat delivery')
        expect(again['instruction_id'] == seen['claude']['instruction_id'] and again['request_id'] == seen['claude']['request_id'], 'a repeat delivery made a second instruction')
        n = f.sql("SELECT count(*)::int AS n FROM hyperfide.outbox_events WHERE aggregate_id=$1 AND event_type='instruction.steer'", [i['claude']['attempt']])[0]['n']
        expect(n == 1, 'a repeat delivery queued %d STEERs' % n)
    check('worker.repeat-delivery-is-one-instruction', replay)

    def codex_by_default():
        asks['codex'] = seed_ask('codex', 'question', 'proceed-and-flag', ['staging', 'production'], 'staging', 'Target: Which environment should the smoke test run against?', True)
        asks['secret'] = seed_ask('codex', 'secret', 'block', [], None, 'Token: Paste the deploy token for the staging cluster.', True)
        swept = ok(call('human.ask.sweep', {'limit': 10}, '1.2-asks'), 'sweep')
        expect(swept['decided_by_default'] >= 1, json.dumps(swept)[:600])
        row = ask(asks['codex'])
        expect(row['state'] == 'EXPIRED' and row['decided_by_default'] is True and row['answer'] == 'staging', json.dumps(row))
        result = ok(deliver(asks['codex']), 'Codex decided-by-default delivery')
        expect(result['connector'] == 'codex' and result['decided_by_default'] is True and result['launch_id'] == i['codex']['launch'], json.dumps(result))
        frame = frame_of(steer_row(result['instruction_id']))
        expect(frame['method'] == 'turn/start' and frame['id'] == result['request_id'] and frame['params']['threadId'] == 'native-codex', json.dumps(frame))
        text = frame['params']['input'][0]['text']
        expect(frame['params']['input'][0]['type'] == 'text' and 'recommended option stands: staging' in text, text)
    check('worker.codex-default-answer-queued-as-turn-start', codex_by_default)

    def blocked_secret():
        row = ask(asks['secret'])
        expect(row['state'] == 'EXPIRED' and row['decided_by_default'] is False, json.dumps(row))
        refused(deliver(asks['secret']), 'ASK_ANSWER_PENDING', 'an expired blocking secret')
    check('negative.expired-blocking-ask-keeps-waiting', blocked_secret)

    def long_answer():
        asks['regions'] = seed_ask('claude', 'question', 'block', [], None, 'Regions: Which regions should receive the canary?', False)
        answer(asks['regions'], 'eu-west, then ' + 'x' * 9000)
        result = ok(deliver(asks['regions']), 'long answer')
        frame = frame_of(steer_row(result['instruction_id']))
        expect(result['answer_truncated'] is True and result['frame_bytes'] <= FRAME_BYTES and 'ask_status ' + asks['regions'] in frame['message']['content'], json.dumps(result))
    check('worker.long-answer-fits-one-frame', long_answer)

    def runner_receives():
        polled = ok(call('instructions.runner.poll', dict(s, limit=16, lease_ms=5000), '6.3', 'runner'), 'runner poll')
        bodies = []
        for command in polled.get('commands', []):
            packet = command.get('packet') or {}
            if packet.get('kind') == 'STEER':
                bodies.append(json.loads(unb64url(packet['payload_base64url'])))
        launches = sorted(b['launch_id'] for b in bodies)
        expect(len(bodies) == 3 and launches == sorted([i['claude']['launch'], i['claude']['launch'], i['codex']['launch']]),
               'the runner did not receive the three answer STEERs: ' + json.dumps(polled)[:1200])
    check('worker.runner-polls-the-answers', runner_receives)

    def refusals():
        refused(deliver(asks['claude'], key='runner'), 'AUTH_ROLE_DENIED', 'a runner delivering an answer')
    check('negative.runner-cannot-deliver', refusals)

    def leader():
        inspected = ok(call('supervisor.session.inspect', {'launch_id': i['supervisor_launch']}, '13.4.supervision'), 'supervision inspect')
        expect(len(inspected['asks']) == 1, json.dumps(inspected)[:600])
        lead = inspected['asks'][0]['ask_id']
        refused(call('supervisor.session.answer', {'launch_id': i['supervisor_launch'], 'ask_id': lead}, '13.4.supervision'), 'ASK_ANSWER_PENDING', 'an open leader Ask')
        answer(lead, 'Wait for 4.9 (Recommended)')
        refused(deliver(lead), 'ASK_NOT_WORKER', 'a leader Ask through worker instructions')
        refused(call('supervisor.session.answer', {'launch_id': i['supervisor_launch'], 'ask_id': asks['claude']}, '13.4.supervision'),
                'SUPERVISOR_ANSWER_SCOPE_DENIED', 'a worker Ask into the leader session')
        refused(call('supervisor.session.answer', {'launch_id': uid(), 'ask_id': lead}, '13.4.supervision'), 'SUPERVISOR_LAUNCH_NOT_FOUND', 'an unknown launch')
        # Same launch state, same guard: the answer takes the session-input path and stops where input stops.
        f.sql("UPDATE hyperfide.supervisor_launches SET native_session_id='native-leader',process_identity='{\"pid\":4242}'::jsonb WHERE id=$1", [i['supervisor_launch']])
        via_input = call('supervisor.session.input', {'launch_id': i['supervisor_launch'], 'operation_id': uid(), 'text': 'probe'}, '13.4.supervision')
        via_answer = call('supervisor.session.answer', {'launch_id': i['supervisor_launch'], 'ask_id': lead}, '13.4.supervision')
        code = lambda resp: (resp.get('error') or {}).get('code')
        expect(via_input.get('ok') is False and via_answer.get('ok') is False and code(via_input) and code(via_answer) == code(via_input),
               'leader answer and session input disagree: ' + json.dumps([via_input, via_answer])[:900])
        expect(code(via_answer) in ('SUPERVISOR_NATIVE_UNQUALIFIED', 'SUPERVISOR_MAIN_BUDGET_UNCONFIGURED', 'SUPERVISOR_CREDENTIAL_UNAVAILABLE'), code(via_answer))
        print(json.dumps({'type': 'note', 'leader_guard': code(via_answer)}), flush=True)
    check('leader.answer-is-session-input', leader)


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
