#!/usr/bin/env python3
"""qualify.py --suite runs a registry task suite member by member (task 7.9).

A disposable workspace holds a registry whose task_suites name passing, failing, env-gated and
unpinned task variants. The real qualify.py and check-evidence.py run unmodified against it; the
last check reads the tracked registry's governance and core suites.
"""
import hashlib, json, pathlib, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
TESTS = ROOT / "tests/hyperfide"
QUALIFY, CHECKER = TESTS / "qualify.py", TESTS / "check-evidence.py"
FAILED = []
ABSENT = "HF_V21_7_9_ABSENT_PREREQUISITE"
GOVERNANCE = ["1.2", "6.1", "6.2", "6.3", "6.4", "13.4", "18.1", "18.2", "18.3", "18.4", "20.1", "20.2", "20.3", "20.4",
              "21.1", "21.2", "21.3", "21.4", "23.1", "23.2", "23.3", "23.4"]
CORE = ["27.1", "1.4", "4.1", "4.2", "4.4", "8.1", "10.1", "11.1", "29.1", "29.2", "29.3", "29.4", "29.5", "29.6", "29.7",
        "29.8", "29.9", "29.11", "29.12"]


def probe(actual):
    return ('import json\nprint(json.dumps({"type":"assertion","id":"suite.alpha","expected":1,"actual":%d}))\n'
            'print(json.dumps({"type":"cleanup","resources":[],"complete":True}))\n' % actual)


def expect(value, message="assertion failed"):
    if not value:
        raise AssertionError(message)


def check(name, fn):
    identity = "qualify.suite." + name
    try:
        actual = fn() or "observed"
    except Exception as error:  # every failure is reported, none is swallowed
        actual = type(error).__name__ + ": " + str(error)
        FAILED.append(identity)
    print(json.dumps({"type": "assertion", "id": identity, "expected": "observed", "actual": actual}), flush=True)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def pin(workspace, label):
    data = (workspace / label).read_bytes()
    return {"path": label, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def register(workspace, task, script, required_env=(), manifest=True):
    write_json(workspace / "registrations" / (task + ".json"), {
        "schema_version": 1, "variant": "task:" + task, "task": task, "scope": "task-component", "cases": ["V-056"],
        "assertion_ids": ["suite.alpha"], "argv": [sys.executable, script], "timeout_seconds": 60,
        "required_env": list(required_env), "fixtures": [], "resources": [], "source_files": [script], "source_roots": ["probes"]})
    if manifest:
        write_json(workspace / "manifests" / "tasks" / (task + ".json"), {
            "schema_version": 1, "campaign_id": "suite-" + task, "registered_variant": "task:" + task, "scope": "task-component",
            "case_ids": ["V-056"], "expected_assertion_ids": ["suite.alpha"], "approval": {"approved": True, "allowed_actions": []},
            "inputs": [pin(workspace, script)], "resources": [], "seed": 1, "policy": {}})


def qualify(workspace, *argv, registry="registry.json"):
    run = subprocess.run([sys.executable, str(QUALIFY), "--root", str(workspace), "--registry", str(workspace / registry), *argv],
                         capture_output=True, text=True, timeout=600)
    return run.returncode, run.stdout, run.stderr


def main():
    with tempfile.TemporaryDirectory(prefix="hf-v21-7-9-") as ws:
        workspace = pathlib.Path(ws).resolve()
        (workspace / "probes").mkdir()
        (workspace / "probes" / "pass.py").write_text(probe(1))
        (workspace / "probes" / "fail.py").write_text(probe(0))
        (workspace / "probes" / "skip.py").write_text('import sys\nprint("SKIP: fixture binary absent; set HF_V21_7_9_BINARY", flush=True)\nsys.exit(77)\n')
        register(workspace, "7.91", "probes/pass.py")
        register(workspace, "7.92", "probes/pass.py", required_env=[ABSENT])
        register(workspace, "7.93", "probes/fail.py")
        register(workspace, "7.94", "probes/pass.py", manifest=False)
        register(workspace, "7.95", "probes/skip.py")
        registry = {"schema_version": 1, "cases": {"V-056": {"title": "suite runner", "full_assertion_ids": []}},
                    "suites": {"contract": ["V-056"]}, "registration_glob": "registrations/*.json",
                    "task_suites": {"good": ["7.91"], "gated": ["7.91", "7.92"], "unpinned": ["7.94"], "failing": ["7.93"], "probe-skip": ["7.95"]}}
        write_json(workspace / "registry.json", registry)
        write_json(workspace / "bad-registry.json", {**registry, "task_suites": {"ghost": ["7.91", "7.99"]}})

        def passing_suite_records_evidence():
            code, out, err = qualify(workspace, "--suite", "good", "--format", "text")
            expect(code == 0, "passing suite exit %d: %s %s" % (code, out[-600:], err[-600:]))
            expect("PASS task:7.91 receipt " in out and "suite good: PASS, 1 passed, 0 failed, 0 skipped" in out, out)
            campaigns = list((workspace / "artifacts/hyperfide/tasks/7.91/campaigns").glob("*/evidence-index.json"))
            expect(len(campaigns) == 1, "no evidence index under the task evidence path")
            checked = subprocess.run([sys.executable, str(CHECKER), "--campaign", str(campaigns[0].parent)], capture_output=True, text=True, timeout=120)
            expect(checked.returncode == 0, "check-evidence refused the member's campaign: " + checked.stdout[-400:])
            return "PASS, evidence at artifacts/hyperfide/tasks/7.91/campaigns/<key>, check-evidence accepts it"

        def absent_prerequisite_skips_and_fails():
            code, out, _ = qualify(workspace, "--suite", "gated", "--format", "text")
            expect(code == 1, "suite with a SKIP member exited %d" % code)
            expect("SKIP task:7.92: cannot run: " + ABSENT + " unset" in out, "SKIP line does not name the prerequisite: " + out)
            expect("PASS task:7.91" in out and "suite gated: FAIL, 1 passed, 0 failed, 1 skipped" in out, out)
            expect("PASS task:7.92" not in out, "a skipped member was reported PASS")
            return "SKIP names " + ABSENT + "; suite exit 1"

        def unpinned_member_skips():
            code, out, _ = qualify(workspace, "--suite", "unpinned", "--format", "json")
            result = json.loads(out.strip().splitlines()[-1])
            member = result["members"][0]
            expect(code == 1 and result["status"] == "FAIL" and member["status"] == "SKIP", out)
            expect(member["prerequisites"] == ["no tracked manifest pins task:7.94"], json.dumps(member))
            return "SKIP: " + member["prerequisites"][0]

        def failing_member_fails():
            code, out, _ = qualify(workspace, "--suite", "failing", "--format", "text")
            expect(code == 1 and "FAIL task:7.93" in out and "suite failing: FAIL, 0 passed, 1 failed, 0 skipped" in out, out)
            return "FAIL, exit 1"

        def probe_exit_77_skips():
            code, out, _ = qualify(workspace, "--suite", "probe-skip", "--format", "text")
            expect(code == 1 and "SKIP task:7.95: cannot run: SKIP: fixture binary absent; set HF_V21_7_9_BINARY" in out, out)
            expect("suite probe-skip: FAIL, 0 passed, 0 failed, 1 skipped" in out, out)
            return "probe exit 77 reported SKIP with its own prerequisite line"

        def unknown_suite_blocked():
            code, out, _ = qualify(workspace, "--suite", "nosuch", "--format", "text")
            expect(code == 2 and json.loads(out.strip().splitlines()[-1])["status"] == "BLOCKED", "unknown suite: exit %d %s" % (code, out))
            return "BLOCKED, exit 2"

        def unregistered_member_blocked():
            code, out, _ = qualify(workspace, "--suite", "ghost", "--format", "text", registry="bad-registry.json")
            result = json.loads(out.strip().splitlines()[-1])
            expect(code == 2 and result["status"] == "BLOCKED" and "unregistered task" in result["diagnostics"][0], out)
            return result["diagnostics"][0]

        def tracked_suites_match_inventory():
            tracked = json.loads((TESTS / "registry.json").read_text())["task_suites"]
            expect(tracked == {"governance": GOVERNANCE, "core": CORE}, "tracked suites differ: " + json.dumps(tracked))
            pinned = {json.loads(path.read_text()).get("registered_variant") for path in (TESTS / "manifests").glob("**/*.json")}
            unpinned = [task for task in GOVERNANCE + CORE if "task:" + task not in pinned]
            expect(not unpinned, "members without a tracked manifest: " + ", ".join(unpinned))
            code, out, _ = qualify(ROOT, "--list-cases", "--format", "text", registry="tests/hyperfide/registry.json")
            expect(code == 0, "the tracked registry with task_suites does not load: " + out[-400:])
            return "governance %d members, core %d members, all registered and pinned" % (len(GOVERNANCE), len(CORE))

        for name, fn in (("pass-evidence", passing_suite_records_evidence), ("skip-prerequisite", absent_prerequisite_skips_and_fails),
                         ("skip-unpinned", unpinned_member_skips), ("fail-member", failing_member_fails), ("skip-probe-77", probe_exit_77_skips),
                         ("unknown-suite", unknown_suite_blocked), ("unregistered-member", unregistered_member_blocked),
                         ("tracked-inventory", tracked_suites_match_inventory)):
            check(name, fn)
    print(json.dumps({"type": "cleanup", "resources": [], "complete": True}))
    if FAILED:
        print("FAIL: " + ", ".join(FAILED), file=sys.stderr)
        return 1
    print("PASS: 8 checks", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
