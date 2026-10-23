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


if __name__ == "__main__":
    if sys.argv[1:] != ["--projection-host"]:
        raise SystemExit("use AuthorityFixture from the qualification case")
    projection_host()
