#!/usr/bin/env python3
"""Full-case probe for a V-case: every registered component variant plus its live leg.

A component PASS never certifies a full case (verification.md section 2). This
probe re-executes every registered task-component variant of one V-case in a
single receipt, each in its own campaign subdirectory, and re-emits each
component assertion under the case namespace together with the component's
exit, inventory, cleanup and artifact obligations. Where verification.md needs
infrastructure the components only simulate, the case also runs a live leg:
an existing campaign driver, or an approved bridge named by an environment
variable. Missing prerequisites are declared in the registration's
required_env, so qualify.py reports BLOCKED and names them; nothing here falls
back to a simulator or passes by omission.

    compose.py V-NNN [--variant X]            run components and the live leg
    compose.py V-NNN [--variant X] --cleanup  run component cleanups, emit the one cleanup event
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
HYPERFIDE = ROOT / "tests/hyperfide"
REGISTRATIONS = HYPERFIDE / "registrations"
REGISTRY = HYPERFIDE / "registry.json"
SELF = "tests/hyperfide/cases/full/compose.py"
COMPONENT_OBLIGATIONS = ("exit-clean", "inventory-exact", "cleanup-complete", "artifacts-present")

PROVIDER_CASES = ["V-036", "V-037", "V-038", "V-039", "V-040", "V-041"]
RAILWAY_CASES = ["V-064", "V-065"]
NATIVE_CASES = ["V-042", "V-043", "V-044"]

# One live leg per case at most. A "driver" leg runs an existing campaign
# driver against the approved manifest in `env`; a "bridge" leg runs the
# approved, content-pinned bridge command described by the manifest in `env`.
# Recovery cases (campaigns/faults.py RECOVERY_CASES) carry no fault leg:
# the fault campaign consumes their full receipts, so a leg would be circular.
LEGS = {
    "deterministic": {"kind": "driver", "cases": ["V-047", "V-048", "V-049"], "task": "27.2",
                      "env": "HYPERFIDE_DETERMINISTIC_MANIFEST", "timeout": 86400,
                      "driver": "tests/hyperfide/campaigns/deterministic.py", "execute": False},
    "live-48h": {"kind": "driver", "cases": ["V-050"], "task": "27.3",
                 "env": "HYPERFIDE_LIVE_48H_MANIFEST", "timeout": 3 * 86400,
                 "driver": "tests/hyperfide/campaigns/live.py", "execute": True},
    "live-72h": {"kind": "driver", "cases": ["V-051"], "task": "27.3",
                 "env": "HYPERFIDE_LIVE_72H_MANIFEST", "timeout": 4 * 86400,
                 "driver": "tests/hyperfide/campaigns/live.py", "execute": True},
    "provider": {"kind": "bridge", "cases": PROVIDER_CASES + RAILWAY_CASES, "task": "27.3",
                 "env": "HYPERFIDE_FULL_PROVIDER_{VARIANT}_MANIFEST", "timeout": 6 * 3600},
    "native": {"kind": "bridge", "cases": NATIVE_CASES, "task": "27.3",
               "env": "HYPERFIDE_FULL_NATIVE_{VARIANT}_MANIFEST", "timeout": 6 * 3600},
    "advisory": {"kind": "bridge", "cases": ["V-045", "V-046"], "task": "27.3",
                 "env": "HYPERFIDE_FULL_ADVISORY_MANIFEST", "timeout": 12 * 3600},
    "main-host-audit": {"kind": "bridge", "cases": ["V-052"], "task": "27.3",
                        "env": "HYPERFIDE_FULL_MAIN_HOST_AUDIT_MANIFEST", "timeout": 6 * 3600},
    "release-rehearsal": {"kind": "bridge", "cases": ["V-053", "V-054", "V-055"], "task": "28.3",
                          "env": "HYPERFIDE_FULL_RELEASE_REHEARSAL_MANIFEST", "timeout": 12 * 3600},
}
DEFAULT_TASK = "28.3"


class ComposeError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ComposeError(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def task_key(task):
    major, minor = task.split(".")
    return int(major), int(minor)


def variants(case):
    """Provider and connector variants: one execution cannot claim another."""
    if case in PROVIDER_CASES:
        return ["railway", "blaxel"]
    if case in RAILWAY_CASES:
        return ["railway"]
    if case in NATIVE_CASES:
        return ["codex", "claude_code"]
    return [None]


def leg_of(case):
    names = [name for name, leg in LEGS.items() if case in leg["cases"]]
    require(len(names) <= 1, "more than one live leg declared for " + case)
    return names[0] if names else None


def leg_env(leg_name, variant):
    env = LEGS[leg_name]["env"]
    if "{VARIANT}" in env:
        require(variant is not None, "variant leg needs a variant")
        env = env.replace("{VARIANT}", variant.upper())
    return env


def components(case):
    """Every registered task-component variant of the case, in task order."""
    found = []
    for path in sorted(REGISTRATIONS.glob("*.json")):
        registration = read_json(path)
        if registration.get("scope") == "task-component" and case in registration.get("cases", []):
            found.append((registration, path))
    require(found, "no registered component variant for " + case)
    found.sort(key=lambda item: task_key(item[0]["task"]))
    return found


def full_inventory(case):
    ids = []
    for registration, _ in components(case):
        prefix = case + "." + registration["task"] + "."
        ids.extend(prefix + identity for identity in registration["assertion_ids"])
        ids.extend(prefix + obligation for obligation in COMPONENT_OBLIGATIONS)
    leg = leg_of(case)
    if leg:
        ids.append(case + ".leg." + leg)
    require(len(ids) == len(set(ids)), "full inventory has duplicate identities for " + case)
    return ids


def has_cleanup(case):
    return any(registration.get("cleanup_argv") for registration, _ in components(case))


def emit(identity, expected, actual):
    print(json.dumps({"type": "assertion", "id": identity, "expected": expected, "actual": actual}, sort_keys=True), flush=True)


def parse_events(data):
    assertions, cleanups = [], []
    for line in data.decode("utf-8", "replace").splitlines():
        if not line.strip().startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "assertion" and isinstance(event.get("id"), str):
            assertions.append(event)
        elif event.get("type") == "cleanup":
            cleanups.append(event)
    return assertions, cleanups


def last_json(data):
    for line in reversed(data.decode("utf-8", "replace").splitlines()):
        if line.strip().startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return {}


def run(argv, env, timeout, log_prefix):
    """Run one child in its own process group; report, never hide, stray descendants."""
    child = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate()
    leaked = False
    try:
        os.killpg(child.pid, 0)
        leaked = True
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    log_prefix.parent.mkdir(parents=True, exist_ok=True)
    Path(str(log_prefix) + ".stdout.log").write_bytes(stdout)
    Path(str(log_prefix) + ".stderr.log").write_bytes(stderr)
    return {"exit_code": child.returncode, "timed_out": timed_out, "leaked_descendants": leaked}, stdout, stderr


def campaign_dir():
    base = os.environ.get("HYPERFIDE_CAMPAIGN_DIR")
    require(base, "HYPERFIDE_CAMPAIGN_DIR absent: run through qualify.py")
    return Path(base)


def state_path(directory, task):
    return directory / "full-state" / (task + ".json")


def component_env(directory, registration):
    env = os.environ.copy()
    env["HYPERFIDE_CAMPAIGN_DIR"] = str(directory / "components" / registration["task"])
    env["HYPERFIDE_CASE_IDS"] = json.dumps(registration["cases"])
    return env


def run_components(case, directory):
    for registration, _ in components(case):
        task = registration["task"]
        (directory / "components" / task).mkdir(parents=True, exist_ok=True)
        result, stdout, _ = run(registration["argv"], component_env(directory, registration),
                                registration.get("timeout_seconds", 60), directory / "full-logs" / (task + ".main"))
        assertions, cleanups = parse_events(stdout)
        state = {"task": task, "main": result, "assertions": assertions, "cleanups": cleanups, "cleanup_run": None}
        path = state_path(directory, task)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, sort_keys=True))


def run_component_cleanups(case, directory):
    for registration, _ in components(case):
        if not registration.get("cleanup_argv"):
            continue
        task = registration["task"]
        path = state_path(directory, task)
        state = read_json(path) if path.is_file() else {"task": task, "main": None, "assertions": [], "cleanups": []}
        (directory / "components" / task).mkdir(parents=True, exist_ok=True)
        result, stdout, _ = run(registration["cleanup_argv"], component_env(directory, registration),
                                registration.get("cleanup_timeout_seconds", 60), directory / "full-logs" / (task + ".cleanup"))
        assertions, cleanups = parse_events(stdout)
        state["assertions"] = state.get("assertions", []) + assertions
        state["cleanups"] = state.get("cleanups", []) + cleanups
        state["cleanup_run"] = result
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, sort_keys=True))


def resource_resolved(resource):
    if resource.get("status") == "deleted":
        return resource.get("observed_absent") is True and bool(resource.get("evidence_artifact"))
    if resource.get("status") == "retained":
        return bool(resource.get("owner")) and bool(resource.get("expiry"))
    return False


def report_components(case, directory):
    """Re-emit every component obligation and return the aggregated cleanup event."""
    resources, complete = [], True
    for registration, _ in components(case):
        task = registration["task"]
        prefix = case + "." + task + "."
        path = state_path(directory, task)
        state = read_json(path) if path.is_file() else None
        observed = {}
        observed_ids = []
        for event in (state or {}).get("assertions", []):
            observed_ids.append(event["id"])
            observed.setdefault(event["id"], event)
        for identity in registration["assertion_ids"]:
            event = observed.get(identity)
            if event is None or "expected" not in event or "actual" not in event:
                emit(prefix + identity, {"executed": True}, {"executed": False})
            else:
                emit(prefix + identity, event["expected"], event["actual"])
        runs = [] if state is None else [state.get("main")] + ([state.get("cleanup_run")] if registration.get("cleanup_argv") else [])
        clean = {"exit_code": 0, "timed_out": False, "leaked_descendants": False}
        actual_runs = [run if run is not None else {"exit_code": None, "timed_out": None, "leaked_descendants": None} for run in runs]
        expected_runs = [clean] * (1 + (1 if registration.get("cleanup_argv") else 0))
        emit(prefix + "exit-clean", expected_runs, actual_runs if state is not None else [{"executed": False}])
        emit(prefix + "inventory-exact", sorted(registration["assertion_ids"]), sorted(observed_ids))
        cleanups = (state or {}).get("cleanups", [])
        declared = sorted(item["id"] for item in registration.get("resources", []))
        event = cleanups[0] if len(cleanups) == 1 and isinstance(cleanups[0], dict) else {}
        listed = event.get("resources") if isinstance(event.get("resources"), list) else []
        actual_ids = sorted(item.get("id") for item in listed if isinstance(item, dict))
        unresolved = sorted(str(item.get("id")) for item in listed if not isinstance(item, dict) or not resource_resolved(item))
        actual_cleanup = {"events": len(cleanups), "complete": event.get("complete") is True, "resource_ids": actual_ids, "unresolved": unresolved}
        expected_cleanup = {"events": 1, "complete": True, "resource_ids": declared, "unresolved": []}
        emit(prefix + "cleanup-complete", expected_cleanup, actual_cleanup)
        if actual_cleanup != expected_cleanup:
            complete = False
        for item in listed:
            if isinstance(item, dict):
                namespaced = dict(item)
                namespaced["id"] = task + ":" + str(item.get("id"))
                if isinstance(item.get("evidence_artifact"), str):
                    namespaced["evidence_artifact"] = "components/" + task + "/" + item["evidence_artifact"]
                resources.append(namespaced)
        required = sorted(registration.get("required_artifacts", []))
        base = directory / "components" / task
        present = sorted(name for name in required if (base / name).is_file() and not (base / name).is_symlink())
        emit(prefix + "artifacts-present", required, present)
    return {"type": "cleanup", "resources": resources, "complete": complete}


def run_leg(case, variant, directory):
    name = leg_of(case)
    if name is None:
        return
    leg = LEGS[name]
    identity = case + ".leg." + name
    env_name = leg_env(name, variant)
    manifest = os.environ.get(env_name)
    evidence = directory / "legs" / name
    evidence.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({"HYPERFIDE_CAMPAIGN_DIR": str(evidence), "HYPERFIDE_FULL_CASE": case,
                "HYPERFIDE_FULL_LEG": name, "HYPERFIDE_FULL_VARIANT": variant or ""})
    if leg["kind"] == "driver":
        expected = {"status": "PASS", "exit_code": 0}
        if not manifest:
            emit(identity, expected, {"status": "BLOCKED", "reason": env_name + " absent"})
            return
        argv = [sys.executable, leg["driver"], "--manifest", manifest, "--evidence", str(evidence)] + (["--execute"] if leg["execute"] else [])
        result, stdout, stderr = run(argv, env, leg["timeout"], evidence / "driver")
        reported = last_json(stdout) or last_json(stderr)
        emit(identity, expected, {"status": reported.get("status"), "exit_code": result["exit_code"]})
        return
    expected = {"status": "PASS", "exit_code": 0, "case": case, "variant": variant}
    try:
        require(manifest, env_name + " absent: approved bridge manifest required")
        bridge = read_json(manifest)
        require(isinstance(bridge, dict) and bridge.get("schema_version") == 1, "unsupported bridge manifest")
        require(bridge.get("leg") == name and bridge.get("variant") == variant, "bridge manifest is for another leg or variant")
        require(isinstance(bridge.get("cases"), list) and case in bridge["cases"], "bridge manifest does not cover " + case)
        argv = bridge.get("argv")
        require(isinstance(argv, list) and argv and all(isinstance(arg, str) and arg for arg in argv), "invalid bridge argv")
        pins = bridge.get("pins")
        require(isinstance(pins, list) and pins, "bridge code must be content-pinned")
        pinned = set()
        for pin in pins:
            require(isinstance(pin, dict) and set(pin) == {"path", "sha256"}, "malformed bridge pin")
            target = Path(pin["path"]) if Path(pin["path"]).is_absolute() else ROOT / pin["path"]
            require(target.is_file() and sha256(target) == pin["sha256"], "bridge pin mismatch: " + pin["path"])
            pinned.add(target.resolve())
        for arg in argv:
            target = Path(arg) if Path(arg).is_absolute() else ROOT / arg
            if target.is_file() and target.suffix in (".py", ".js", ".mjs", ".sh"):
                require(target.resolve() in pinned, "unpinned bridge code: " + arg)
        timeout = bridge.get("timeout_seconds", leg["timeout"])
        require(isinstance(timeout, int) and not isinstance(timeout, bool) and 0 < timeout <= leg["timeout"], "bridge timeout exceeds the registered leg")
        (evidence / "bridge-manifest.sha256").write_text(sha256(manifest) + "\n")
    except (ComposeError, OSError, ValueError) as exc:
        emit(identity, expected, {"status": "BLOCKED", "reason": str(exc)})
        return
    result, stdout, _ = run(argv, env, timeout, evidence / "bridge")
    reported = last_json(stdout)
    emit(identity, expected, {"status": reported.get("status"), "exit_code": result["exit_code"],
                              "case": reported.get("case"), "variant": reported.get("variant")})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case")
    parser.add_argument("--variant")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(args.variant in variants(args.case), "unregistered variant for " + args.case)
        registry = read_json(REGISTRY)
        declared = registry["cases"].get(args.case, {}).get("full_assertion_ids")
        require(declared == full_inventory(args.case), "registry full inventory differs from the registered components of " + args.case)
        directory = campaign_dir()
    except (ComposeError, OSError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "BLOCKED", "error": str(exc)}), file=sys.stderr)
        return 2
    if args.cleanup:
        run_component_cleanups(args.case, directory)
        event = report_components(args.case, directory)
        print(json.dumps(event, sort_keys=True), flush=True)
        return 0 if event["complete"] else 1
    run_components(args.case, directory)
    run_leg(args.case, args.variant, directory)
    if not has_cleanup(args.case):
        event = report_components(args.case, directory)
        print(json.dumps(event, sort_keys=True), flush=True)
        return 0 if event["complete"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
