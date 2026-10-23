#!/usr/bin/env python3
"""Disposable fleet qualification fixture.

FLEET_PROJECTION is the removable local interface for unmerged tasks 5.3-5.6.
It uses local Git repositories as fake machines; no cloud or model is contacted.

ASKS_PROJECTION is the removable Ask plugin boundary for unmerged tasks 3.1-3.4
(task 3.5): threads, provider execution, interrupts, transcripts, Ask
persistence and events are real.

AuthorityFixture (task 6.5) is the removable authority/multi-host projection for
unmerged tasks 6.2-6.4: HTTP operator authentication, PostgreSQL plugin state,
enrollment, dispatch and qualification receipts. Replace it with the merged
client/server APIs when those tasks land.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import hashlib
import secrets
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]


class PlatformBuildAbsent(Exception):
    pass


def run_fleet():
    tsx = ROOT / 'platform/node_modules/.bin/tsx'
    if not tsx.is_file():
        raise PlatformBuildAbsent('platform dependencies absent; run pnpm -C platform install')
    with tempfile.TemporaryDirectory(prefix='hyperfide-fleet-') as directory:
        entry = Path(directory) / 'fleet-projection.mts'
        entry.write_text(FLEET_PROJECTION)
        result = subprocess.run([str(tsx), str(entry), directory], cwd=ROOT,
                                capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'fleet fixture failed ({result.returncode}):\n{result.stderr}\n{result.stdout}')
        return json.loads(result.stdout)


FLEET_PROJECTION = r'''
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const root = process.argv[2];
const repo = join(root, 'integration');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8',
  env:{...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
const identity = cwd => {git(cwd,'config','user.name','Hyperfide fixture'); git(cwd,'config','user.email','fixture@hyperfide.test');};
mkdirSync(repo);
git(repo,'init','-b','main'); identity(repo);
mkdirSync(join(repo,'spec/fleet'),{recursive:true});
const spec = ['A','B','C'].map(id => `[task.${id}]\nstatus = "pending"\nrequires = ${id === 'A' ? '[]' : '["A"]'}\n`).join('\n');
writeFileSync(join(repo,'spec/fleet/spec.kvx'),spec);
git(repo,'add','.'); git(repo,'commit','-m','Create fleet spec');
const initial = git(repo,'rev-parse','HEAD');
const machines = [], events = [], ledgers = [];
let tick = 0, active = 0, peak = 0;
const cap = 2, keys = ['fixture-key-1', 'fixture-key-2'], leasedKeys = new Set();
const event = (job,state) => {const item={task:job.task,state,sequence:++tick}; events.push(item); job.timeline.push(item); job.state=state;};
class FakeMachineProvider {
  create(checkpoint) {
    const machine={id:`machine-${machines.length+1}`,provider:'fake',state:'running',checkpoint,path:join(root,`machine-${machines.length+1}`)};
    mkdirSync(machine.path); machines.push(machine); return machine;
  }
  upload(machine,bundle) {git(machine.path,'clone','-b','main',bundle,'.');identity(machine.path);}
  destroy(machine) {machine.state='destroyed';}
}
const provider = new FakeMachineProvider();
const storage = join(root,'ledger.json');
const persist = () => writeFileSync(storage,JSON.stringify(ledgers));
// The image builder executes local base steps against the uploaded commit bundle.
const builder=provider.create('parent');
const baseBundle=join(root,'base.bundle'); git(repo,'bundle','create',baseBundle,'main');
provider.upload(builder,baseBundle);
const steps=[];
for (const name of ['clone','cg','service','platform','index','tools']) {
  const start=performance.now();
  if (name === 'clone') git(builder.path,'fsck','--no-dangling');
  else git(builder.path,'rev-parse','HEAD');
  steps.push({name,state:'succeeded',duration:performance.now()-start});
}
const image={checkpoint:`hf-base-${initial.slice(0,10)}`,commit:initial,steps};
provider.destroy(builder);
writeFileSync(join(root,'image.json'),JSON.stringify(image));
const statuses=()=>Object.fromEntries([...readFileSync(join(repo,'spec/fleet/spec.kvx'),'utf8').matchAll(/\[task\.(\w+)\]\nstatus = "(\w+)"/g)].map(m=>[m[1],m[2]]));
const echoRunner = async (machine,job) => {
  // Actual child processes overlap; the barrier below makes parallelism observable.
  const code=`const fs=require('node:fs'); fs.writeFileSync('result-${job.task}.txt','echo ${job.task}\\n');`;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',code],{cwd:machine.path,stdio:'pipe'});
    child.on('error',reject); child.on('close',code=>code===0?resolve():reject(Error('echo runner failed')));
  });
  const path=join(machine.path,'spec/fleet/spec.kvx');
  writeFileSync(path,readFileSync(path,'utf8').replace(`[task.${job.task}]\nstatus = "pending"`,`[task.${job.task}]\nstatus = "implemented"`));
  git(machine.path,'add','.');git(machine.path,'commit','-m',`Implement ${job.task}`);
  job.workerCommit=git(machine.path,'rev-parse','HEAD');
};
async function dispatch(tasks) {
  if (tasks.length > cap || active + tasks.length > cap) throw Error('concurrency cap exceeded');
  const tip=git(repo,'rev-parse','HEAD');
  const bundle=join(root,`input-${tick}.bundle`);git(repo,'bundle','create',bundle,'main');
  let release; const barrier=new Promise(resolve=>{release=resolve;}); let entered=0;
  await Promise.all(tasks.map(async task=>{
    const job={task,state:'created',attempt:1,base:tip,timeline:[],log:[]};ledgers.push(job);event(job,'created');
    job.key=keys.find(key=>!leasedKeys.has(key));
    if (!job.key) throw Error('key pool exhausted');
    leasedKeys.add(job.key);
    const machine=provider.create(image.checkpoint);job.machine=machine.id;
    provider.upload(machine,bundle);git(machine.path,'checkout','-b',`worker-${task}`);
    event(job,'prepared');active++;peak=Math.max(peak,active); event(job,'running');
    if (++entered===tasks.length) release(); await barrier;
    try {
      await echoRunner(machine,job);job.log.push(`echo ${task}`);
      job.bundle=join(root,`result-${task}.bundle`);git(machine.path,'bundle','create',job.bundle,`worker-${task}`);
      event(job,'packed');
    } finally {active--;leasedKeys.delete(job.key);provider.destroy(machine);persist();}
  }));
}
function collectAndIntegrate() {
  for (const job of ledgers.filter(j=>j.state==='packed')) {
    git(repo,'fetch',job.bundle,`worker-${job.task}:refs/heads/sandbox/${job.task}`);event(job,'collected');
    git(repo,'merge-tree','--write-tree','HEAD',`sandbox/${job.task}`);
    git(repo,'merge','--no-ff',`sandbox/${job.task}`,'-m',`Integrate ${job.task} [spec:fleet/${job.task}]`);
    job.merge=git(repo,'rev-parse','HEAD'); event(job,'merged');persist();
  }
}
const ready=()=>Object.entries(statuses()).filter(([id,state])=>state==='pending' && !ledgers.some(j=>j.task===id) && (id==='A'||ledgers.some(j=>j.task==='A'&&j.state==='merged'))).map(([id])=>id);
const first=ready();await dispatch(first);
const beforeCollect=ready();collectAndIntegrate();
const second=ready();await dispatch(second);
const parallelSnapshot=JSON.parse(readFileSync(storage,'utf8'));
collectAndIntegrate();
// Reload persisted records for the dashboard RPC read model.
function dashboardRpc(method) {
  if(method!=='fleet.snapshot') throw Error('unknown RPC');
  return {machines:machines.map(({path,...m})=>m),jobs:JSON.parse(readFileSync(storage,'utf8')),
    budget:{cap,inFlight:active,keys:keys.length,backoffUntil:null},image:JSON.parse(readFileSync(join(root,'image.json'),'utf8'))};
}
const merges=ledgers.map(j=>({task:j.task,hash:j.merge,message:git(repo,'show','-s','--format=%s',j.merge),
  parents:git(repo,'show','-s','--format=%P',j.merge).split(' '),worker:j.workerCommit,
  content:git(repo,'show',`${j.merge}:result-${j.task}.txt`)}));
console.log(JSON.stringify({interface:'fleet-projection',initial,image,first,beforeCollect,second,peak,
  ledgers:JSON.parse(readFileSync(storage,'utf8')),parallelSnapshot,merges,statuses:statuses(),dashboard:dashboardRpc('fleet.snapshot')}));
'''


PLATFORM = ROOT / "platform"


def require_platform_build():
    entry = PLATFORM / "apps/server/dist/index.js"
    if not entry.is_file():
        print(f"SKIP: platform build absent: {entry}", flush=True)
        raise SystemExit(77)


# Delete this projection when the Ask plugin supplies these RPCs. Its policy is
# taken from the binary's store, rather than duplicating the kind table.
ASKS_PROJECTION = r"""
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createIntegrationHarness } from './HYPERFIDE_HARNESS';
import { createProjectFixture, createReadyHostThread } from './helpers/fixtures.ts';
import { getThread, getThreadEvents, getThreadOutput, sendTextMessage, stopThread }
  from './helpers/api.ts';
import { waitForThreadStatus } from './helpers/assertions.ts';

const harness = await createIntegrationHarness();
try {
const binary = process.env.HYPERFIDE_TEST_BINARY;
const task = 'asks-e2e/variable';
function cg(...args) {
  return execFileSync(binary, args, {
    cwd: harness.repoDir, encoding: 'utf8',
    env: { ...process.env, CG_TASK: task },
  });
}
cg('init');
const project = await createProjectFixture(harness, {name: 'Hyperfide Ask E2E'});
const {thread} = await createReadyHostThread(harness, {
  projectId: project.id, providerId: 'fake',
  workspace: {type: 'unmanaged', path: harness.repoDir},
});
let paused = null;
const annotations = [];
const notifications = [];
const seen = new Set();
const resumed = new Set();
function asks(all = false) {
  return JSON.parse(cg('ask', 'list', ...(all ? ['--all'] : []), '--json')).asks;
}
async function sync() {
  for (const ask of asks(true)) {
    if (!seen.has(ask.id)) {
      seen.add(ask.id);
      if (ask.blocking) {
        await stopThread(harness.api, thread.id);
        await waitForThreadStatus(harness.api, thread.id, 'idle', 15000);
        paused = {askId: ask.id, reason: ask.title};
        notifications.push({askId: ask.id, task: ask.task,
          kind: ask.kind, deadline: ask.deadline});
      } else if (ask.default_policy === 'proceed-and-flag') {
        annotations.push({askId: ask.id, flagged: true,
          recommendation: ask.recommended});
      }
    }
    if (paused?.askId === ask.id && ask.state === 'answered' && !resumed.has(ask.id)) {
      await sendTextMessage(harness.api, thread.id, {text: `Ask #${ask.id} answered: ${ask.answer}`});
      await waitForThreadStatus(harness.api, thread.id, 'idle', 15000);
      resumed.add(ask.id);
      paused = null;
    }
  }
}
async function rpc(method, params) {
  if (method === 'thread.raise') {
    if (paused) throw new Error('thread is paused');
    await sendTextMessage(harness.api, thread.id, {text: `Raise ${params.kind} Ask: ${params.question}`});
    await waitForThreadStatus(harness.api, thread.id, 'idle', 15000);
    const ask = JSON.parse(cg('ask', 'raise', params.kind, params.question,
      '--task', task, '--option', params.recommendation,
      '--recommend', params.recommendation, '--deadline', '1h', '--json'));
    await sync();
    return ask;
  }
  if (method === 'inbox.list') { await sync(); return asks(); }
  if (method === 'inbox.answer') {
    cg('ask', 'answer', String(params.id), params.answer, '--json');
    await sync(); return asks(true);
  }
  if (method === 'thread.send') {
    if (paused) throw new Error('thread is paused');
    await sendTextMessage(harness.api, thread.id, {text: params.text});
    await waitForThreadStatus(harness.api, thread.id, 'idle', 15000);
    return true;
  }
  if (method === 'thread.get') {
    await sync();
    return {thread: await getThread(harness.api, thread.id), paused,
      annotations, notifications, events: await getThreadEvents(harness.api, thread.id),
      output: await getThreadOutput(harness.api, thread.id)};
  }
  if (method === 'store.list') return asks(true);
  if (method === 'journal.list') return cg('events', '--kind', 'ask.', '--json', '-n', '100')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  throw new Error(`unknown RPC: ${method}`);
}
function emit(value) { process.stdout.write('HYPERFIDE_RPC ' + JSON.stringify(value) + '\n'); }
emit({ready: true, repository: harness.repoDir, threadId: thread.id, projection: true});
  for await (const line of createInterface({input: process.stdin})) {
    const request = JSON.parse(line);
    if (request.method === 'close') break;
    try { emit({id: request.id, result: await rpc(request.method, request.params ?? {})}); }
    catch (error) { emit({id: request.id, error: String(error.stack ?? error)}); }
  }
} finally { await harness.cleanup(); }
"""


class PlatformFixture:
    """JSON RPC client; all child failures and timeouts fail qualification."""

    def __enter__(self):
        require_platform_build()
        self.files = []
        self.process = None
        self.log = tempfile.TemporaryFile(mode="w+")
        try:
            integration = PLATFORM / "tests/integration"
            source = integration / "helpers/harness.ts"
            # The shared harness loads developer env files. Disable that call
            # before importing it; this case must never read .env files.
            harness = source.read_text().replace("  await loadProjectEnvFile();", "")
            if harness == source.read_text():
                raise RuntimeError("harness env-loading contract changed")
            harness_file = self._write(source.parent, harness)
            driver = ASKS_PROJECTION.replace(
                "./HYPERFIDE_HARNESS", f"./helpers/{harness_file.name}"
            )
            driver_file = self._write(integration, driver)
            env = dict(os.environ, HYPERFIDE_TEST_BINARY=str(ROOT / "cg"))
            self.process = subprocess.Popen(
                ["node", "--conditions=source", "--import", "tsx", str(driver_file)],
                cwd=PLATFORM, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.log, text=True, bufsize=1,
            )
            self.selector = selectors.DefaultSelector()
            self.selector.register(self.process.stdout, selectors.EVENT_READ)
            self.buffer = b""
            self.ready = self._read(180)
            if not self.ready.get("ready"):
                raise RuntimeError(self.ready)
            self.sequence = 0
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _write(self, directory, text):
        with tempfile.NamedTemporaryFile(
            mode="w", prefix="hyperfide-asks-projection-", suffix=".ts",
            dir=directory, delete=False,
        ) as handle:
            handle.write(text)
            path = Path(handle.name)
        self.files.append(path)
        return path

    def _read(self, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if line.startswith(b"HYPERFIDE_RPC "):
                    return json.loads(line.removeprefix(b"HYPERFIDE_RPC "))
            if not self.selector.select(min(1, max(0, deadline - time.monotonic()))):
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                break
            self.buffer += chunk
        self.log.seek(0)
        raise RuntimeError(f"platform RPC timed out or exited: {self.log.read()}")

    def rpc(self, method, **params):
        self.sequence += 1
        self.process.stdin.write(json.dumps({
            "id": self.sequence, "method": method, "params": params,
        }) + "\n")
        self.process.stdin.flush()
        response = self._read()
        if response.get("id") != self.sequence or "error" in response:
            raise RuntimeError(response)
        return response["result"]

    def __exit__(self, *_):
        if self.process:
            if self.process.poll() is None:
                self.process.stdin.close()
                try:
                    self.process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            self.process.stdout.close()
        if hasattr(self, "selector"):
            self.selector.close()
        for path in self.files:
            path.unlink(missing_ok=True)
        self.log.close()


# ── Task 6.5: authority / multi-host projection ──────────────────────────────
BUILD = ROOT / "platform/apps/server/dist/index.js"


def request(url, token, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = Request(url, data=body, headers={"Authorization": "Bearer " + token,
                                         "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=15) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            status, result = self.server.operation(
                self.command, self.path, self.headers.get("Authorization", "").removeprefix("Bearer "), data)
        except Exception as error:
            status, result = 500, {"error": str(error)}
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(operation):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.operation = operation
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:" + str(server.server_port)


class AuthorityFixture:
    """Own all processes and projected state inside an already-owned PG cluster."""

    def __init__(self):
        self.folder = tempfile.TemporaryDirectory(prefix="hyperfide-platform-")
        self.path = Path(self.folder.name)
        self.children, self.servers, self.logs = [], [], []
        self.operator = secrets.token_hex(24)
        self.host_token = secrets.token_hex(24)
        self.enrollment = {name: secrets.token_hex(24) for name in ("host-1", "host-2")}
        self.lock = threading.Lock()
        self.psql = str(Path(os.environ["HYPERFIDE_PG_BIN"]) / "psql")

    def sql(self, statement):
        result = subprocess.run([self.psql, os.environ["DATABASE_URL"], "-XAt", "-v", "ON_ERROR_STOP=1"],
                                input=statement, capture_output=True, text=True, timeout=20, check=True)
        return result.stdout.strip()

    def rows(self, query):
        return json.loads(self.sql("SELECT coalesce(json_agg(row_to_json(r)), '[]') FROM (" + query + ") r"))

    @staticmethod
    def literal(value):
        return "'" + str(value).replace("'", "''") + "'"

    def spawn(self, command, env=None):
        log = (self.path / ("process-" + str(len(self.logs)) + ".log")).open("w+")
        self.logs.append(log)
        child = subprocess.Popen(command, cwd=self.path, env=env, stdout=log, stderr=log)
        self.children.append(child)
        return child

    def wait(self, predicate, label):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in self.children):
                break
            try:
                if predicate():
                    return
            except (URLError, ConnectionError):
                pass
            time.sleep(0.1)
        diagnostics = []
        for log in self.logs:
            log.flush()
            log.seek(0)
            diagnostics.append(log.read()[-4000:])
        raise RuntimeError(label + " failed\n" + "\n".join(diagnostics))

    def __enter__(self):
        try:
            self.start()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def start(self):
        self.sql("""CREATE SCHEMA hyperfide_platform_projection;
            SET search_path = hyperfide_platform_projection;
            CREATE TABLE operators (token text PRIMARY KEY, name text NOT NULL);
            CREATE TABLE hosts (id text PRIMARY KEY, url text NOT NULL, capacity int NOT NULL);
            CREATE TABLE tasks (id text PRIMARY KEY, host text REFERENCES hosts(id),
                                state text NOT NULL, operator text NOT NULL);
            CREATE TABLE receipts (task text PRIMARY KEY REFERENCES tasks(id), host text NOT NULL,
                                   verdict text NOT NULL CHECK(verdict='pass'), digest text NOT NULL,
                                   output text NOT NULL);
            INSERT INTO operators VALUES (""" + self.literal(self.operator) + ", 'fixture-operator');")
        authority, self.authority_url = serve(self.authority)
        self.servers.append(authority)
        env = {key: value for key, value in os.environ.items() if not key.startswith("HYPERFIDE_")}
        env.update(HYPERFIDE_AUTHORITY_URL=self.authority_url,
                   HYPERFIDE_DATA_DIR=str(self.path / "platform"),
                   HYPERFIDE_SERVER_PORT=str(unused_port()), HYPERFIDE_SERVER_BIND_HOST="127.0.0.1",
                   HYPERFIDE_HOST_DAEMON_PORT=str(unused_port()),
                   # Keep catalog refreshes local, without a dependency on the public registry.
                   HYPERFIDE_MARKETPLACE_URL="https://127.0.0.1:9/hyperfide-fixture.json",
                   HYPERFIDE_SKIP_ONBOARDING="1")
        self.platform_url = "http://127.0.0.1:" + env["HYPERFIDE_SERVER_PORT"]
        self.spawn(["node", str(BUILD)], env)
        self.wait(lambda: request(self.platform_url + "/health", self.operator)[0] == 200, "platform health")
        for name, token in list(self.enrollment.items()):
            host_env = dict(env, HYPERFIDE_FIXTURE_HOST=name, HYPERFIDE_FIXTURE_ENROLLMENT=token,
                            HYPERFIDE_FIXTURE_HOST_TOKEN=self.host_token)
            self.spawn([sys.executable, str(Path(__file__).resolve()), "--projection-host"], host_env)
        self.wait(lambda: len(self.rows("SELECT * FROM hyperfide_platform_projection.hosts")) == 2,
                  "two host enrollments")
        self.hosts = {row["id"]: row["url"] for row in self.rows("SELECT * FROM hyperfide_platform_projection.hosts")}

    def authority(self, method, path, token, data):
        q = self.literal
        schema = "hyperfide_platform_projection."
        if path == "/enroll" and method == "POST":
            with self.lock:
                if token != self.enrollment.get(data["host"]):
                    return 403, {"error": "enrollment refused"}
                self.sql("INSERT INTO " + schema + "hosts VALUES (" + q(data["host"]) + "," + q(data["url"]) + ",1)")
                del self.enrollment[data["host"]]
            return 201, {"host": data["host"]}
        if not self.rows("SELECT name FROM " + schema + "operators WHERE token=" + q(token)):
            return 403, {"error": "operator not allow-listed"}
        if path == "/dispatch" and method == "POST":
            assert request(self.platform_url + "/health", token)[0] == 200
            hosts = self.rows("SELECT * FROM " + schema + "hosts WHERE id=" + q(data["host"]))
            if not hosts:
                return 404, {"error": "host not enrolled"}
            self.sql("INSERT INTO " + schema + "tasks VALUES (" + q(data["task"]) + "," + q(data["host"]) + ",'running','fixture-operator')")
            status, receipt = request(hosts[0]["url"] + "/execute", self.host_token, data)
            if status != 200:
                self.sql("UPDATE " + schema + "tasks SET state='failed' WHERE id=" + q(data["task"]))
                return status, receipt
            assert receipt["host"] == data["host"] and receipt["verdict"] == "pass"
            self.sql("BEGIN; INSERT INTO " + schema + "receipts VALUES (" + ",".join(q(receipt[k]) for k in
                     ("task", "host", "verdict", "digest", "output")) + "); UPDATE " + schema +
                     "tasks SET state='qualified' WHERE id=" + q(data["task"]) + "; COMMIT;")
            return 201, receipt
        if path.startswith("/tasks/") and method == "GET":
            records = self.rows("SELECT t.*, r.verdict, r.digest, r.output FROM " + schema + "tasks t LEFT JOIN " +
                                schema + "receipts r ON r.task=t.id WHERE t.id=" + q(path.removeprefix("/tasks/")))
            return (200, records[0]) if records else (404, {"error": "unknown task"})
        return 404, {"error": "unknown route"}

    def __exit__(self, *args):
        for child in reversed(self.children):
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for log in self.logs:
            log.close()
        self.folder.cleanup()


def projection_host():
    name = os.environ["HYPERFIDE_FIXTURE_HOST"]
    authority = os.environ["HYPERFIDE_AUTHORITY_URL"]

    def operation(method, path, token, data):
        if path == "/execute" and method == "POST":
            if token != os.environ["HYPERFIDE_FIXTURE_HOST_TOKEN"]:
                return 403, {"error": "host authentication refused"}
            if data["host"] != name:
                return 409, {"error": "wrong host"}
            result = subprocess.run(data["command"], capture_output=True, text=True, timeout=20,
                                    env=dict(os.environ, HYPERFIDE_TASK_HOST=name))
            if result.returncode:
                return 422, {"error": "qualification failed", "code": result.returncode}
            output = result.stdout
            return 200, {"task": data["task"], "host": name, "verdict": "pass", "output": output,
                         "digest": "sha256:" + hashlib.sha256(output.encode()).hexdigest()}
        return request(authority + path, token, data if method == "POST" else None)

    server, url = serve(operation)
    status, _ = request(authority + "/enroll", os.environ["HYPERFIDE_FIXTURE_ENROLLMENT"],
                        {"host": name, "url": url})
    assert status == 201, "host enrollment failed"
    try:
        threading.Event().wait()
    finally:
        server.shutdown()


if __name__ == "__main__" and sys.argv[1:2] != ["--closure-json"]:  # --closure-json is handled by the 4.5 block at the end
    if sys.argv[1:] != ["--projection-host"]:
        raise SystemExit("use AuthorityFixture from the qualification case")
    projection_host()

# ---- SpecFixture (task 2.6): the built platform server, host daemon and echo provider against a fixture
# repository with .codegraph and a spec. SPEC_PROJECTION_ADAPTER is the removable stand-in for the spec
# plugin RPCs of unmerged tasks 2.3/2.4.
import shutil as _shutil, signal as _signal, urllib.error as _urlerror, urllib.request as _urlrequest


PLATFORM = ROOT / 'platform'


class SpecBuildAbsent(PlatformBuildAbsent):
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


class SpecFixture:
    def __enter__(self):
        entries = [PLATFORM / 'apps' / app / 'dist/index.js' for app in ('server', 'host-daemon')]
        missing = [str(p) for p in entries if not p.is_file()]
        if missing:
            raise SpecBuildAbsent('platform build absent: ' + ', '.join(missing))
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
        req = _urlrequest.Request(self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            with _urlrequest.urlopen(req, timeout=90) as response:
                return json.load(response)
        except _urlerror.HTTPError as error:
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
        _shutil.copytree(example, echo, ignore=_shutil.ignore_patterns('node_modules', 'recordings'))
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
        _shutil.copytree(checkout_source, checkout, ignore=_shutil.ignore_patterns('node_modules', 'dist'))
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
                os.killpg(proc.pid, _signal.SIGTERM)
        for proc in reversed(self.processes):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, _signal.SIGKILL)
                proc.wait(timeout=10)
        for log in self.logs:
            log.close()
        self.temp.cleanup()

    def __exit__(self, *_):
        self.close()


# ---- QualificationProjection (task 4.5): implemented, lane, checker, receipt, wave closure and permission-gated
# publication to a local bare remote. Temporary projection of the unmerged qualify plugin RPCs (4.1 to 4.4); replace
# with the shared platform RPC fixture once they land.
import importlib.util as _importlib_util
import re
import urllib.request

QUALIFICATION_BUILD = [ROOT / 'platform/apps' / app / 'dist/index.js'
         for app in ('server', 'host-daemon')]


def require_qualification_build():
    missing = [str(p.relative_to(ROOT)) for p in QUALIFICATION_BUILD if not p.is_file()]
    if missing:
        print('SKIP 77 platform build absent: ' + ', '.join(missing))
        raise SystemExit(77)


def closure_module():
    spec = _importlib_util.spec_from_file_location(
        'hyperfide_closure', ROOT / 'tests/hyperfide/closure_check.py')
    module = _importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QualificationProjection:
    """Local adapter for the unmerged qualification and publication RPCs."""

    def __enter__(self):
        require_qualification_build()
        self.temp = tempfile.TemporaryDirectory(prefix='hyperfide-platform-')
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.env = dict(os.environ, HYPERFIDE_DATA_DIR=str(self.base / 'data'),
                        GIT_AUTHOR_NAME='Hyperfide', GIT_COMMITTER_NAME='Hyperfide',
                        GIT_AUTHOR_EMAIL='fixture@hyperfide.dev',
                        GIT_COMMITTER_EMAIL='fixture@hyperfide.dev')
        self.processes = []
        self.logs = []
        try:
            for entry, key in zip(QUALIFICATION_BUILD, ('HYPERFIDE_SERVER_PORT', 'HYPERFIDE_HOST_DAEMON_PORT')):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                self.env[key] = str(port)
            self.env['HYPERFIDE_SERVER_BIND_HOST'] = '127.0.0.1'
            self.env['HYPERFIDE_SERVER_URL'] = 'http://127.0.0.1:' + self.env['HYPERFIDE_SERVER_PORT']
            # Keep catalog traffic local; qualification installs no catalog plugins.
            self.env['HYPERFIDE_MARKETPLACE_URL'] = self.env['HYPERFIDE_SERVER_URL'] + '/fixture-catalog.json'
            for entry, key in zip(QUALIFICATION_BUILD, ('HYPERFIDE_SERVER_PORT', 'HYPERFIDE_HOST_DAEMON_PORT')):
                if key == 'HYPERFIDE_HOST_DAEMON_PORT':
                    request = urllib.request.Request(
                        self.env['HYPERFIDE_SERVER_URL'] + '/internal/hosts/enroll-key',
                        data=b'{}', headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=10) as response:
                        enrollment = json.load(response)
                        self.env['HYPERFIDE_HOST_ENROLL_KEY'] = enrollment['enrollKey']
                        self.env['HYPERFIDE_HOST_ID'] = enrollment['hostId']
                log = (self.base / (entry.parent.parent.name + '.log')).open('w+')
                self.logs.append(log)
                proc = subprocess.Popen(['node', str(entry)], cwd=self.base,
                                        env=self.env, stdout=log, stderr=log)
                self.processes.append(proc)
                deadline = time.monotonic() + 45
                while True:
                    if proc.poll() is not None or time.monotonic() > deadline:
                        log.seek(0)
                        raise RuntimeError('platform startup failed: ' + log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', int(self.env[key])), .2):
                            break
                    except OSError:
                        time.sleep(.1)
            self.git('init', '-q', '-b', 'main')
            self.write('.gitignore', '.codegraph/\nartifacts/\n')
            self.write('src/value.txt', 'pending\n')
            self.write('verify.py', "import pathlib\nassert pathlib.Path('src/value.txt').read_text() == 'implemented\\n'\nprint('lane verified')\n")
            self.write('manifest.json', '{}\n')
            self.write('spec/workflow.kvx', '[meta]\nactive_feature = "hyperfide"\n[mode]\nname = "prod"\n')
            self.spec = self.repo / 'spec/hyperfide/spec.kvx'
            self.write('spec/hyperfide/spec.kvx', '[meta]\nfeature = "hyperfide"\n[task.1.1]\ntitle = "Fixture task"\nstatus = "pending"\nwave = 1\nrequires = []\ntouches = ["src/value.txt"]\nverify_cmd = "python3 verify.py --case V-001 --manifest manifest.json"\n')
            self.git('add', '.')
            self.git('commit', '-qm', 'Fixture base')
            self.base_commit = self.git('rev-parse', 'HEAD').stdout.strip()
            self.run([str(ROOT / 'cg'), 'init'])
            self.remote = self.base / 'remote.git'
            self.run(['git', 'init', '--bare', '-q', str(self.remote)])
            self.git('remote', 'add', 'origin', str(self.remote))
            return self
        except BaseException:
            for log in self.logs:
                log.flush()
                log.seek(0)
                print(log.read()[-8000:])
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        for proc in reversed(self.processes):
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for log in self.logs:
            log.close()
        self.temp.cleanup()

    def run(self, argv, check=True):
        result = subprocess.run(argv, cwd=self.repo, env=self.env,
                                text=True, capture_output=True, timeout=90)
        if check and result.returncode:
            raise RuntimeError(f'{argv}: {result.returncode}\n{result.stdout}{result.stderr}')
        return result

    def git(self, *args):
        return self.run(['git', *args])

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def status(self, value):
        self.spec.write_text(re.sub(r'^status = .*$', 'status = ' + json.dumps(value),
                                   self.spec.read_text(), flags=re.M))

    def implement(self):
        self.run([str(ROOT / 'cg'), 'spec', 'start', '1.1'])
        self.write('src/value.txt', 'implemented\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Implement fixture value')
        self.run([str(ROOT / 'cg'), 'spec', 'implemented', '1.1'])
        self.git('add', '.')
        self.git('commit', '-qm', 'Record implementation')

    def qualify(self):
        closure = closure_module()
        started = time.monotonic()
        lane = self.run(['python3', 'verify.py', '--case', 'V-001', '--manifest', 'manifest.json'])
        self.lane = dict(state='passed', exit=lane.returncode,
                         duration=time.monotonic() - started)
        campaign = 'artifacts/hyperfide/tasks/1.1/campaigns/qualification'
        self.write(campaign + '/lane.log', lane.stdout + lane.stderr)
        # Independent checker process reruns verification and inspects the diff.
        diff = self.git('diff', self.base_commit, 'HEAD', '--', 'src/value.txt').stdout
        assert '+implemented' in diff
        checker = self.run(['python3', '-I', 'verify.py'])
        self.checker = dict(provider='hyperfide-checker', worker='hyperfide-worker',
                            verdict='pass', exit=checker.returncode)
        self.status('done')
        commit = self.git('rev-parse', 'HEAD').stdout.strip()
        receipt = dict(receipt_id='qualification', task='1.1', selected_case_ids=['V-001'],
                       outcome='PASS', diagnostics=[], source={'commit': commit},
                       manifest_sha256=closure.sha((self.repo / 'manifest.json').read_bytes()),
                       inputs=[dict(original_path=name, sha256=closure.sha((self.repo / name).read_bytes()))
                               for name in ('src/value.txt', 'verify.py')],
                       verify_cmd='python3 verify.py --case V-001 --manifest manifest.json',
                       evidence_paths=[campaign + '/lane.log', campaign + '/checks/qualification.json'],
                       toolchain={'python': self.run(['python3', '--version']).stdout.strip(),
                                  'node': self.run(['node', '--version']).stdout.strip()},
                       **{'exit': 0, 'duration': self.lane['duration']})
        receipt['seal'] = closure.sha(closure.canonical(receipt))
        self.receipt_path = self.write(campaign + '/receipts/qualification.json',
                                       closure.canonical(receipt).decode() + '\n')
        self.write(campaign + '/checks/qualification.json', json.dumps(dict(
            status='PASS', receipt_sha256=closure.sha(self.receipt_path.read_bytes()), **self.checker)))
        self.write('artifacts/hyperfide/tasks/1.1/evidence-index.json', json.dumps(dict(
            task='1.1', commit=commit, requalified_on=commit, exit_code=0)))
        return receipt

    def closure(self):
        return self.run([sys.executable, str(Path(__file__).resolve()),
                         '--closure-json', str(self.repo)]).stdout

    def close_wave(self):
        if any(proc.poll() is not None for proc in self.processes):
            raise RuntimeError('platform exited during qualification')
        result = json.loads(self.closure())
        if result['failures'] or self.lane['state'] != 'passed' or self.checker['verdict'] != 'pass':
            raise RuntimeError('wave closure blocked')
        self.closed = True
        self.run([str(ROOT / 'cg'), 'ask', 'raise', 'permission',
                  'Publish fixture wave to local remote?', '--task', '1.1'])
        listing = self.run([str(ROOT / 'cg'), 'ask', 'list', '--json']).stdout
        self.ask_listing = listing
        asks = json.loads(listing)['asks']
        if len(asks) != 1 or asks[0]['kind'] != 'permission' or asks[0]['state'] != 'open':
            raise RuntimeError('permission Ask id missing: ' + listing)
        self.ask_id = str(asks[0]['id'])

    def publish(self):
        listing = self.run([str(ROOT / 'cg'), 'ask', 'list', '--all', '--json']).stdout
        # Require the answer recorded in the actual Ask store.
        records = json.loads(listing)
        if isinstance(records, dict):
            records = records.get('asks', [])
        ask = next(a for a in records if str(a['id']) == self.ask_id)
        if ask.get('answer') != 'approve' or ask.get('state') != 'answered':
            raise PermissionError('publication permission unanswered')
        assert self.closed
        self.git('add', '.')
        self.git('commit', '-qm', 'Record qualification')
        self.git('checkout', '-qb', 'publication', self.base_commit)
        self.git('merge', '--squash', 'main')
        self.git('commit', '-qm', 'Publish fixture task [spec:hyperfide/1.1]')
        self.git('push', 'origin', 'publication')
        return self.git('rev-parse', 'HEAD').stdout.strip()


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--closure-json':
        raise SystemExit('usage: platform_fixture.py --closure-json ROOT')
    root = Path(sys.argv[2])
    failures = closure_module().check_task(
        root, (root / 'spec/hyperfide/spec.kvx').read_text(),
        root / 'artifacts/hyperfide/tasks', '1.1')
    print(json.dumps(dict(task='1.1', status='FAIL' if failures else 'PASS', failures=failures)))
