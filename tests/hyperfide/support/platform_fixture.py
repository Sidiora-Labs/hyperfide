#!/usr/bin/env python3
"""Task 6.5 fixture and temporary authority/multi-host projection.

The pending 6.2-6.4 interfaces are isolated here: HTTP operator authentication,
PostgreSQL plugin state, enrollment, dispatch and qualification receipts. Replace
PlatformFixture with the merged client/server APIs when those tasks land. The
built platform server is booted separately; this adapter does not claim that its
current build implements authority storage or multi-host dispatch.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
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


class PlatformFixture:
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
        raise SystemExit("use PlatformFixture from the qualification case")
    projection_host()
