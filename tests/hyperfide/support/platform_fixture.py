"""Real platform harness with a removable Ask projection for tasks 3.1-3.4.

The projection supplies only the missing plugin boundary. Threads, provider
execution, interrupts, transcripts, Ask persistence and events are real.
"""

import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[3]
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
