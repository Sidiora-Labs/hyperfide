"""Owned platform processes and the removable v22 spec projection adapter."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
PLATFORM = ROOT / 'platform'


class BuildAbsent(Exception):
    pass


# Remove this adapter when the spec plugin from 2.3/2.4 lands. It uses the
# public plugin SDK, real threads, and the daemon's provider bridge.
SPEC_PROJECTION_ADAPTER = r'''
import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = process.env.HYPERFIDE_FIXTURE_REPO!;
const binary = process.env.HYPERFIDE_FIXTURE_BINARY!;
const spec = root + "/spec/fixture/spec.kvx";
const journal = root + "/.codegraph/spec-projection-journal.jsonl";
const status = () => readFileSync(spec, "utf8").match(/status = "([^"]+)"/)![1];
const record = (event: string, data: any) => appendFileSync(journal, JSON.stringify({event, ...data}) + "\n");
const contract = defineRpcContract({
  status: {input: z.object({}), output: z.any()},
  runTask: {input: z.object({projectId: z.string(), hostId: z.string(), providerId: z.string()}), output: z.any()},
});
export default function plugin(api: any) {
  let current: any = null;
  api.events.on("thread.idle", ({thread}: any) => {
    if (current && thread.id === current.id && thread.status === "idle") {
      record("thread.finished", {threadId: thread.id, status: status()});
    }
  });
  api.rpc.register(contract, {
    status: () => ({status: status(), threadId: current?.id ?? null}),
    runTask: async (input: any) => {
      if (status() !== "pending") throw new Error("Task is not pending");
      const packet = readFileSync(spec, "utf8") + "\nCG_TASK=fixture/1\nNever set done; write implemented.\n";
      execFileSync(binary, ["spec", "start", "1"], {cwd: root});
      current = await api.sdk.threads.spawn({
        projectId: input.projectId, providerId: input.providerId, model: "echo-1",
        prompt: packet, title: "Fixture spec task",
        environment: {type: "provider", environmentProviderId: "project-checkout",
          machine: {type: "existing", hostId: input.hostId}, inputs: {path: root}},
      });
      record("task.started", {threadId: current.id, packet, providerId: input.providerId, status: "in_progress"});
      return {threadId: current.id, packet};
    },
  });
}
'''


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class PlatformFixture:
    def __enter__(self):
        entries = [PLATFORM / 'apps' / app / 'dist/index.js' for app in ('server', 'host-daemon')]
        missing = [str(p) for p in entries if not p.is_file()]
        if missing:
            raise BuildAbsent('platform build absent: ' + ', '.join(missing))
        self.temp = tempfile.TemporaryDirectory(prefix='hyperfide-platform-')
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repository'
        self.repo.mkdir()
        self.processes = []
        self.logs = []
        self.url = 'http://127.0.0.1:' + str(free_port())
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('CG_', 'HYPERFIDE_'))}
        self.env.update(HYPERFIDE_DATA_DIR=str(self.root / 'data'),
                        HYPERFIDE_SERVER_PORT=self.url.rsplit(':', 1)[1],
                        HYPERFIDE_SERVER_URL=self.url,
                        HYPERFIDE_MARKETPLACE_URL=self.url + '/fixture-marketplace',
                        HYPERFIDE_HOST_DAEMON_PORT=str(free_port()),
                        HYPERFIDE_SKIP_ONBOARDING='1',
                        HYPERFIDE_FIXTURE_REPO=str(self.repo),
                        HYPERFIDE_FIXTURE_BINARY=str(ROOT / 'cg'), CG_TASK='fixture/1')
        try:
            self.prepare_repository()
            self.spawn(entries[0], 'server')
            self.wait(lambda: self.request('/health'), 'server readiness')
            enrollment = self.request('/internal/hosts/enroll-key', {})
            self.env.update(HYPERFIDE_HOST_ENROLL_KEY=enrollment['enrollKey'],
                            HYPERFIDE_HOST_ID=enrollment['hostId'])
            self.host_id = enrollment['hostId']
            self.spawn(entries[1], 'daemon')
            self.wait(lambda: any(h['id'] == self.host_id and h.get('status') == 'connected'
                                 for h in self.request('/api/v1/hosts')), 'daemon enrollment')
            self.install_projection()
            project = self.request('/api/v1/projects', {'name': 'Fixture', 'source': {
                'hostId': self.host_id, 'type': 'local_path', 'path': str(self.repo)}})
            self.project_id = project['id']
            return self
        except BaseException:
            self.close()
            raise

    def prepare_repository(self):
        spec = self.repo / 'spec/fixture/spec.kvx'
        spec.parent.mkdir(parents=True)
        (self.repo / 'spec/workflow.kvx').write_text(
            '[meta]\nactive_feature = "fixture"\n[mode]\nname = "prod"\n')
        spec.write_text('[feature]\nname = "fixture"\nmode = "prod"\n\n[task.1]\ntitle = "Echo implements the task"\nstatus = "pending"\nwave = 0\nrequires = []\ntouches = ["worker.txt"]\nverify_cmd = "test -f worker.txt"\ndo_1 = "Write worker.txt and set implemented"\n')
        self.spec = spec
        for args in (['git', 'init', '-q'], ['git', 'add', '.'],
                     ['git', '-c', 'user.name=Hyperfide', '-c', 'user.email=fixture@hyperfide.local', 'commit', '-qm', 'Fixture'],
                     [str(ROOT / 'cg'), 'init']):
            subprocess.run(args, cwd=self.repo, env=self.env, check=True, capture_output=True)

    def spawn(self, entry, name):
        log = (self.root / (name + '.log')).open('w+')
        self.logs.append(log)
        self.processes.append(subprocess.Popen(['node', str(entry)], cwd=PLATFORM,
                                              env=self.env, stdout=log, stderr=log, start_new_session=True))

    def request(self, path, body=None):
        req = urllib.request.Request(self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise AssertionError(f'{path}: {error.code} {error.read().decode()}') from error

    def wait(self, predicate, reason, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(p.poll() is not None for p in self.processes):
                break
            try:
                result = predicate()
                if result:
                    return result
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        details = []
        for log in self.logs:
            log.flush()
            log.seek(0)
            details.append(log.read()[-6000:])
        raise AssertionError(reason + '\n' + '\n'.join(details))

    def install_projection(self):
        example = PLATFORM / 'examples/plugins/echo-provider'
        echo = self.root / 'hyperfide-echo'
        shutil.copytree(example, echo, ignore=shutil.ignore_patterns('node_modules', 'recordings'))
        (echo / 'node_modules').symlink_to(example / 'node_modules', target_is_directory=True)
        manifest = json.loads((echo / 'package.json').read_text())
        metadata_key = next(k for k, v in manifest.items() if isinstance(v, dict) and 'server' in v)
        manifest['name'] = 'hyperfide-plugin-hyperfide-echo'
        (echo / 'package.json').write_text(json.dumps(manifest))
        bridge = echo / 'src/provider-bridge.ts'
        source = bridge.read_text()
        marker = '  const { session } = args;'
        assert source.count(marker) == 1
        worker = '''
  if (process.env.CG_TASK !== "fixture/1") throw new Error("CG_TASK missing");
  writeFileSync(join(session.cwd, "worker.txt"), process.env.CG_TASK);
  execFileSync(process.env.HYPERFIDE_FIXTURE_BINARY!, ["spec", "implemented", "1"], {cwd: session.cwd});
  appendFileSync(join(session.cwd, ".codegraph/spec-projection-journal.jsonl"), JSON.stringify({event: "provider.implemented", task: process.env.CG_TASK, cwd: session.cwd, status: "implemented"}) + "\\n");
'''
        source = 'import { execFileSync } from "node:child_process";\nimport { appendFileSync } from "node:fs";\n' + source.replace(marker, marker + worker)
        bridge.write_text(source)
        server = echo / 'server.ts'
        server.write_text(server.read_text().replace('env: { passthrough: [ECHO_GREETING_ENV] }',
            'env: { passthrough: [ECHO_GREETING_ENV, "CG_TASK", "HYPERFIDE_FIXTURE_BINARY"] }'))
        adapter = self.root / 'hyperfide-spec-projection'
        adapter.mkdir()
        (adapter / 'node_modules').symlink_to(example / 'node_modules', target_is_directory=True)
        (adapter / 'server.ts').write_text(SPEC_PROJECTION_ADAPTER)
        (adapter / 'package.json').write_text(json.dumps({
            'name': 'hyperfide-plugin-hyperfide-spec-projection', 'version': '0.1.0', 'type': 'module',
            'engines': manifest['engines'], metadata_key: {'name': 'Spec projection',
                'branding': {'icon': 'ListChecks'},
                'description': 'Temporary spec RPC projection for v22 qualification', 'server': './server.ts'}}))
        checkout_source = PLATFORM / 'plugins/environment-project-checkout'
        checkout = self.root / 'hyperfide-checkout'
        shutil.copytree(checkout_source, checkout, ignore=shutil.ignore_patterns('node_modules', 'dist'))
        (checkout / 'node_modules').symlink_to(checkout_source / 'node_modules', target_is_directory=True)
        checkout_manifest = json.loads((checkout / 'package.json').read_text())
        checkout_manifest['name'] = 'hyperfide-plugin-hyperfide-checkout'
        checkout_manifest[metadata_key].pop('app', None)
        (checkout / 'package.json').write_text(json.dumps(checkout_manifest))
        for path in (echo, checkout, adapter):
            result = self.request('/api/v1/plugins/install', {'source': str(path)})
            assert result['plugin']['status'] == 'running', result

    def rpc(self, method, body=None):
        response = self.request('/api/v1/plugins/hyperfide-spec-projection/rpc/' + method, body or {})
        assert response['ok'], response
        return response['result']

    def close(self):
        for proc in reversed(self.processes):
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        for proc in reversed(self.processes):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=10)
        for log in self.logs:
            log.close()
        self.temp.cleanup()

    def __exit__(self, *_):
        self.close()
