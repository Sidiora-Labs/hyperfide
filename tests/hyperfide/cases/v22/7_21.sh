#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset CODEX_HOME
step() {
  local name="$1" start=$SECONDS rc=0
  shift
  "$@" || rc=$?
  printf '7.21: %s seconds=%s exit=%s\n' "$name" "$((SECONDS-start))" "$rc"
  return "$rc"
}
step build pnpm -C platform build
for package in @hyperfide/server @hyperfide/cli hyperfide-plugin-provider-claude-code hyperfide-plugin-provider-codex; do
  step "$package typecheck" pnpm -C platform --filter "$package" typecheck
  step "$package tests" pnpm -C platform --filter "$package" test
done
step 'production import and reimport' python3 - <<'PY'
import json, os, signal, socket, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-21-') as tmp:
    data = Path(tmp)
    home = data / 'home'
    cwd = str(home / 'redacted-project')
    Path(cwd).mkdir(parents=True)
    def transcript(path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('w') as file:
            for index, row in enumerate(rows):
                file.write(json.dumps({'timestamp': f'2026-10-24T12:00:{index:02d}.000Z', **row}) + '\n')
    claude = home / '.claude/projects/redacted/claude-session.jsonl'
    transcript(claude, [
        {'type': 'ai-title', 'sessionId': 'claude-session', 'cwd': cwd, 'title': 'Imported Claude work'},
        {'type': 'user', 'sessionId': 'claude-session', 'cwd': cwd, 'message': {'role': 'user', 'content': 'Inspect Claude project'}},
        {'type': 'assistant', 'sessionId': 'claude-session', 'cwd': cwd, 'message': {'role': 'assistant', 'content': [
            {'type': 'thinking', 'thinking': 'Reviewing Claude files'},
            {'type': 'text', 'text': 'Claude imported reply'},
            {'type': 'tool_use', 'id': 'read-file', 'name': 'Read', 'input': {'file_path': cwd + '/sample.txt'}}]}},
        {'type': 'user', 'sessionId': 'claude-session', 'cwd': cwd, 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'read-file', 'content': 'Redacted file contents'}]}},
    ])
    transcript(home / '.claude/projects/redacted/claude-session/subagents/agent-worker.jsonl', [
        {'type': 'user', 'sessionId': 'claude-session', 'agentId': 'worker', 'isSidechain': True, 'cwd': cwd,
         'message': {'role': 'user', 'content': 'Inspect child files'}},
        {'type': 'assistant', 'sessionId': 'claude-session', 'agentId': 'worker', 'isSidechain': True, 'cwd': cwd,
         'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Child imported reply'}]}},
    ])
    codex = home / '.codex/sessions/2026/10/24/rollout-session.jsonl'
    transcript(codex, [
        {'type': 'session_meta', 'payload': {'id': 'codex-session', 'cwd': cwd}},
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Imported Codex work'}]}},
        {'type': 'response_item', 'payload': {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': 'Reviewing Codex files'}]}},
        {'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': 'shell', 'name': 'exec_command', 'arguments': '{"cmd":"pwd"}'}},
        {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': 'shell', 'output': cwd}},
        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Codex imported reply'}]}},
        {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
    ])
    assert sum(p.stat().st_size for p in home.rglob('*.jsonl')) < 200_000
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    env = {k: v for k, v in os.environ.items()
           if not k.startswith('HYPERFIDE_') and k not in ('NODE_PATH', 'NODE_OPTIONS', 'CODEX_HOME')}
    env.update(HOME=str(home), NODE_ENV='production', HYPERFIDE_SKIP_ONBOARDING='true',
               HYPERFIDE_SERVER_BIND_HOST='127.0.0.1', HYPERFIDE_SERVER_PORT=str(port),
               HYPERFIDE_DATA_DIR=str(data / 'runtime'), HYPERFIDE_SERVER_URL=url)
    def request(path, body=None):
        try:
            payload = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(url + path, data=payload, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise AssertionError(f'{path}: HTTP {error.code}: {error.read().decode()}') from error
    def api(path):
        return request('/api/v1' + path)
    def cli(*args):
        result = subprocess.run([str(repo / 'platform/apps/cli/bin/hyperfide-platform'), *args],
                                env=env, text=True, capture_output=True, timeout=120)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    with (data / 'server.log').open('w+') as log:
        server = subprocess.Popen(['node', str(repo / 'platform/apps/server/dist/index.js')],
                                  cwd=repo / 'platform', env=env, stdout=log, stderr=log,
                                  start_new_session=True)
        daemon = None
        try:
            for _ in range(240):
                assert server.poll() is None, f'server exited: {server.returncode}'
                try:
                    with urllib.request.urlopen(url + '/health', timeout=2) as response:
                        assert response.status == 200
                    break
                except (OSError, TimeoutError):
                    time.sleep(.5)
            else:
                raise RuntimeError('server health timed out')
            enrollment = request('/internal/hosts/enroll-key', {})
            daemon_env = dict(env, HYPERFIDE_HOST_ENROLL_KEY=enrollment['enrollKey'],
                              HYPERFIDE_HOST_ID=enrollment['hostId'])
            daemon = subprocess.Popen(['node', str(repo / 'platform/apps/host-daemon/dist/index.js')],
                                      cwd=repo / 'platform', env=daemon_env, stdout=log,
                                      stderr=log, start_new_session=True)
            for _ in range(120):
                assert daemon.poll() is None, 'host daemon exited'
                if any(host['id'] == enrollment['hostId'] and host.get('status') == 'connected'
                       for host in api('/hosts')):
                    break
                time.sleep(.5)
            else:
                raise AssertionError('host enrollment timed out')
            project = request('/api/v1/projects', {'name': 'Imported sessions project', 'source': {
                'hostId': enrollment['hostId'], 'type': 'local_path', 'path': cwd}})
            sources = api('/threads/import/sources')['sources']
            assert {s['source'] for s in sources if s['count']} == {'claude-code', 'codex'}, sources
            dry = cli('thread', 'import', '--dry-run', '--json')
            assert dry['errors'] == [], dry
            assert api('/threads?includeHidden=true') == [], 'Dry run created threads'
            filtered = api('/threads/import/sources?source=codex')['sources']
            assert len(filtered) == 1 and filtered[0]['source'] == 'codex' and filtered[0]['count'] == 1, filtered
            first = cli('thread', 'import', '--json')
            assert first['errors'] == [], first
            assert first['imported'] == 3, first
            by_title = {t['title']: t for t in first['threads']}
            assert by_title['Imported Claude work']['providerId'] == 'provider-claude-code', first
            assert by_title['Imported Codex work']['providerId'] == 'provider-codex', first
            parent = by_title['Imported Claude work']
            child = next(t for t in first['threads'] if t['id'] not in (parent['id'], by_title['Imported Codex work']['id']))
            assert api('/threads/' + child['id'])['parentThreadId'] == parent['id']
            for title, text in [('Imported Claude work', 'Claude imported reply'), ('Imported Codex work', 'Codex imported reply')]:
                thread = by_title[title]
                details = api('/threads/' + thread['id'])
                assert details['projectId'] == project['id'], details
                assert details['environmentId'], details
                events = api('/threads/' + thread['id'] + '/events?order=asc')
                assert text in json.dumps(events), events
                timeline = api('/threads/' + thread['id'] + '/timeline')
                assert text in json.dumps(timeline), timeline
            second = cli('thread', 'import', '--json')
            assert second['imported'] == 0 and second['updated'] == 0 and second['records'] == 0, second
            assert second['errors'] == [], second
            with codex.open('a') as file:
                file.write(json.dumps({'timestamp': '2026-10-24T12:01:00.000Z', 'type': 'response_item', 'payload': {
                    'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'New appended prompt'}]}}) + '\n')
                file.write(json.dumps({'timestamp': '2026-10-24T12:01:01.000Z', 'type': 'response_item', 'payload': {
                    'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'New appended reply'}]}}) + '\n')
            appended = cli('thread', 'import', '--source', 'codex', '--json')
            assert appended['imported'] == 0 and appended['updated'] == 1 and appended['records'] > 0, appended
            assert appended['errors'] == [], appended
            events = api('/threads/' + by_title['Imported Codex work']['id'] + '/events?order=asc')
            assert 'New appended reply' in json.dumps(events), events
            print('7.21: discovered, imported, rendered child and provider events, reimported idempotently')
        except BaseException:
            time.sleep(.5)
            log.flush()
            log.seek(0)
            print(log.read())
            for server_log in (data / 'runtime/logs').glob('server*.log*'):
                if server_log.is_file():
                    print(server_log.read_text(errors='replace'))
            raise
        finally:
            if daemon is not None:
                if daemon.poll() is None:
                    os.killpg(daemon.pid, signal.SIGTERM)
                try:
                    daemon.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(daemon.pid, signal.SIGKILL)
                    daemon.wait()
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
PY
printf 'ok: 7.21\n'
