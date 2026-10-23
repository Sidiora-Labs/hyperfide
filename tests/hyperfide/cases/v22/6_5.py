#!/usr/bin/env python3
"""Authority end to end, with the isolated 6.2-6.4 projection adapter."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests/hyperfide/support"))
from platform_fixture import BUILD, AuthorityFixture, request
from withpg import postgres_bin


def main():
    if not BUILD.is_file() or not BUILD.with_name("start-server.js").is_file() or not shutil.which("node"):
        print("SKIP: platform server build or Node is absent; build platform/apps/server", file=sys.stderr)
        return 77
    binary = postgres_bin()
    missing = [name for name in ("postgres", "initdb", "pg_ctl", "psql", "pg_isready")
               if not (binary / name).is_file()]
    if missing:
        print("SKIP: PostgreSQL binaries absent: " + ", ".join(missing), file=sys.stderr)
        return 77
    if sys.argv[1:] != ["--owned-cluster"]:
        return subprocess.run([sys.executable, str(ROOT / "tests/hyperfide/support/withpg.py"), "--",
                               sys.executable, str(Path(__file__).resolve()), "--owned-cluster"], cwd=ROOT).returncode
    with AuthorityFixture() as fixture:
        first, second = fixture.hosts["host-1"], fixture.hosts["host-2"]
        assert first != second
        assert fixture.rows("SELECT name FROM hyperfide_platform_projection.operators") == [
            {"name": "fixture-operator"}]
        assert fixture.rows("SELECT id, capacity FROM hyperfide_platform_projection.hosts ORDER BY id") == [
            {"id": "host-1", "capacity": 1}, {"id": "host-2", "capacity": 1}]
        assert request(fixture.authority_url + "/enroll", "unknown-enrollment",
                       {"host": "host-3", "url": first})[0] == 403
        command = [sys.executable, "-c", "import os; assert os.environ['HYPERFIDE_TASK_HOST']=='host-2'; print('qualified on host-2')"]
        task = {"task": "authority-e2e", "host": "host-2", "command": command}
        before = fixture.rows("SELECT * FROM hyperfide_platform_projection.tasks")
        for host in (first, second):
            status, result = request(host + "/dispatch", "unknown-operator", task)
            assert status == 403 and result["error"] == "operator not allow-listed", result
        assert fixture.rows("SELECT * FROM hyperfide_platform_projection.tasks") == before == []
        assert fixture.rows("SELECT * FROM hyperfide_platform_projection.receipts") == []
        status, receipt = request(first + "/dispatch", fixture.operator, task)
        assert status == 201, receipt
        assert receipt == {"task": task["task"], "host": "host-2", "verdict": "pass",
                           "output": "qualified on host-2\n", "digest": "sha256:" +
                           hashlib.sha256(b"qualified on host-2\n").hexdigest()}, receipt
        status, visible = request(first + "/tasks/" + task["task"], fixture.operator)
        assert status == 200 and visible["state"] == "qualified" and visible["host"] == "host-2", visible
        assert visible["digest"] == receipt["digest"] and visible["verdict"] == "pass"
        assert request(second + "/tasks/" + task["task"], fixture.operator) == (200, visible)
        assert request(first + "/tasks/" + task["task"], "unknown-operator")[0] == 403
        records = fixture.rows("SELECT * FROM hyperfide_platform_projection.receipts")
        assert records == [receipt], records
        assert fixture.rows("SELECT * FROM hyperfide_platform_projection.tasks") == [
            {"id": task["task"], "host": "host-2", "state": "qualified", "operator": "fixture-operator"}]
        failed = dict(task, task="failed-qualification", command=[sys.executable, "-c", "raise SystemExit(9)"])
        status, result = request(first + "/dispatch", fixture.operator, failed)
        assert status == 422 and result["code"] == 9, result
        assert fixture.rows("SELECT * FROM hyperfide_platform_projection.receipts") == records
        assert fixture.rows("SELECT state FROM hyperfide_platform_projection.tasks WHERE id='failed-qualification'") == [{"state": "failed"}]
    print("ok: platform boot; two enrolled projection hosts; dispatch, qualification, PostgreSQL receipt, cross-host read, operator refusal")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
