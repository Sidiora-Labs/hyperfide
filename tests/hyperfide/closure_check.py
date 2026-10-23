#!/usr/bin/env python3
"""Closure check for hyperfide tasks requalified under hyperfide-v21 (tasks 7.1 to 7.8).

closure_check.py <id>...  passes only when, for every id:
  1. [task.<id>] in spec/hyperfide/spec.kvx has status "done";
  2. every case its verify_cmd selects (--case V-NNN) has a sealed PASS receipt under
     artifacts/hyperfide/tasks/<id>/campaigns/*/receipts/ whose independent check is PASS,
     whose source commit is reachable from HEAD, and whose pinned inputs (the manifest
     pins, and the manifest itself) match the tree as it is now;
     A pinned spec/hyperfide/spec.kvx is compared with its status lines masked: cg spec start
     rewrites the task's own status for the verify and every later fold writes done for the
     tasks that close after it, so a spec that records qualification state never matches its
     pin byte for byte; touches, requires, verify_cmd and reason lines still have to match, and
     the pinned bytes come from the campaign's own copy of the input (no copy, strict compare).
  3. artifacts/hyperfide/tasks/<id>/evidence-index.json is re-pointed: commit and
     requalified_on are commits on HEAD's history (not the pre-rewrite twins kept alive
     under refs/evidence/*, decision D10), requalified_on is the commit of one of those
     PASS receipts, and exit_code is 0.

Before checking any id it runs a negative self-test on a synthetic repository: a good
closure must pass and each single defect (status, seal, checker, pin drift, unreachable
commit, orphan index) must fail, so a checker that cannot fail never reports success.

The artifacts are gitignored local data. A task worktree reads them from its own tree,
else from the main checkout that shares the repository (as 80_qualification_inputs.sh
does); --artifacts or HYPERFIDE_ARTIFACTS overrides both.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TASK_ID = re.compile(r"^[0-9]+\.[0-9]+$")


def canonical(value):
    # Must equal qualify.py canonical(): the seal is the digest of these bytes.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *argv):
    return subprocess.run(["git", "-C", str(root), *argv], capture_output=True, text=True, timeout=30)


def task_block(spec_text, task):
    match = re.search(r"^\[task\." + re.escape(task) + r"\]\n(.*?)(?=^\[|\Z)", spec_text, re.S | re.M)
    return match.group(1) if match else None


def kv(block, key):
    match = re.search(r"^" + re.escape(key) + r"\s*=\s*(.*)$", block, re.M)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except ValueError:
        return match.group(1).strip()


def reachable(root, commit):
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        return False
    if git(root, "cat-file", "-e", commit + "^{commit}").returncode != 0:
        return False
    return git(root, "merge-base", "--is-ancestor", commit, "HEAD").returncode == 0


def default_artifacts(root):
    override = os.environ.get("HYPERFIDE_ARTIFACTS")
    if override:
        return Path(override)
    local = root / "artifacts/hyperfide/tasks"
    if local.is_dir():
        return local
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common.returncode == 0:
        shared = Path(common.stdout.strip()).parent / "artifacts/hyperfide/tasks"
        if shared.is_dir():
            return shared
    return local


def receipts_of(task_dir):
    """Yield (receipt, receipt_path, campaign_dir) for every receipt file of a task."""
    for path in sorted(task_dir.glob("campaigns/*/receipts/*.json")):
        try:
            yield json.loads(path.read_bytes()), path, path.parent.parent
        except (OSError, ValueError):
            yield None, path, path.parent.parent


STATUS_LINE = re.compile(rb'^status = "[^"\n]*"\n?', re.M)


def qualification_state_only(campaign, item, current):
    """True when a pinned spec.kvx differs from the tree only in task status lines (see the module docstring)."""
    if Path(item.get("original_path", "")).name != "spec.kvx":
        return False
    for folder in ("inputs", "sources"):
        candidate = campaign / folder / str(item.get("sha256")) / "spec.kvx"
        try:
            pinned = candidate.read_bytes()
        except OSError:
            continue
        if sha(pinned) == item.get("sha256"):
            return STATUS_LINE.sub(b"", pinned) == STATUS_LINE.sub(b"", current.read_bytes())
    return False


def receipt_problems(root, receipt, path, campaign, manifest_path):
    """Reasons a receipt cannot count as current passing evidence; empty when it can."""
    if not isinstance(receipt, dict):
        return ["unreadable receipt"]
    problems = []
    body = {key: value for key, value in receipt.items() if key != "seal"}
    if receipt.get("seal") != sha(canonical(body)):
        problems.append("seal does not match receipt content")
    if receipt.get("outcome") != "PASS" or receipt.get("diagnostics"):
        problems.append("outcome " + str(receipt.get("outcome")) + " " + json.dumps(receipt.get("diagnostics")))
    check_path = campaign / "checks" / (str(receipt.get("receipt_id")) + ".json")
    try:
        check = json.loads(check_path.read_bytes())
        if check.get("status") != "PASS" or check.get("receipt_sha256") != sha(path.read_bytes()):
            problems.append("independent check is not PASS for these receipt bytes")
    except (OSError, ValueError):
        problems.append("independent check missing")
    commit = (receipt.get("source") or {}).get("commit")
    if not reachable(root, commit):
        problems.append("evidence commit " + str(commit) + " not reachable from HEAD")
    if not manifest_path.is_file() or receipt.get("manifest_sha256") != sha(manifest_path.read_bytes()):
        problems.append("manifest changed since the receipt (re-pin required)")
    for item in receipt.get("inputs") or []:
        label = item.get("original_path", "")
        current = Path(label) if os.path.isabs(label) else root / label
        if not current.is_file():
            problems.append("pinned source missing: " + label)
        elif sha(current.read_bytes()) != item.get("sha256") and not qualification_state_only(campaign, item, current):
            problems.append("pinned source drifted: " + label)
    if not receipt.get("inputs"):
        problems.append("receipt pins no inputs")
    return problems


def check_task(root, spec_text, artifacts, task):
    """Return a list of failure strings for one task id (empty means closed)."""
    if not TASK_ID.fullmatch(task):
        return ["invalid task id"]
    block = task_block(spec_text, task)
    if block is None:
        return ["no [task." + task + "] in spec/hyperfide/spec.kvx"]
    failures = []
    status = kv(block, "status")
    if status != "done":
        failures.append("status is " + str(status) + ", not done")
    verify = kv(block, "verify_cmd") or ""
    selections = re.findall(r"--case\s+(\S+)\s+--manifest\s+(\S+)", verify)
    if not selections:
        failures.append("verify_cmd selects no --case/--manifest pair")
    task_dir = artifacts / task
    receipts = list(receipts_of(task_dir))
    passing_commits = set()
    for case, manifest in selections:
        manifest_path = root / manifest
        candidates = [r for r in receipts if isinstance(r[0], dict) and r[0].get("task") == task
                      and r[0].get("selected_case_ids") == [case]]
        if not candidates:
            failures.append(case + ": no receipt")
            continue
        best = None
        for receipt, path, campaign in sorted(candidates, key=lambda r: str(r[0].get("sealed_at")), reverse=True):
            problems = receipt_problems(root, receipt, path, campaign, manifest_path)
            if not problems:
                passing_commits.add(receipt["source"]["commit"])
                best = None
                break
            if best is None:
                best = (receipt.get("receipt_id"), problems)
        if best is not None:
            failures.append(case + ": no current passing receipt; newest " + str(best[0]) + ": " + "; ".join(best[1][:4]))
    index_path = task_dir / "evidence-index.json"
    try:
        index = json.loads(index_path.read_bytes())
    except (OSError, ValueError):
        failures.append("evidence index missing or unreadable: " + str(index_path))
        return failures
    for field in ("commit", "requalified_on"):
        if not reachable(root, index.get(field)):
            failures.append("evidence index " + field + "=" + str(index.get(field)) + " is not on HEAD's history (not re-pointed)")
    if index.get("exit_code") != 0:
        failures.append("evidence index exit_code is " + str(index.get("exit_code")))
    if passing_commits and index.get("requalified_on") not in passing_commits:
        failures.append("evidence index requalified_on is not the commit of a passing receipt")
    return failures


# ---- negative self-test -------------------------------------------------------------

def _fixture(base, defect):
    """Build a synthetic repository holding one closure of task 1.1, with one defect."""
    root = base / defect
    (root / "spec/hyperfide").mkdir(parents=True)
    (root / "src").mkdir()
    (root / "m").mkdir()
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    def run(*argv):
        subprocess.run(["git", "-C", str(root), *argv], check=True, capture_output=True, env=env, timeout=30)
    run("init", "-q")
    (root / "src/a.c").write_text("int a;\n")
    manifest = {"inputs": [{"path": "src/a.c", "sha256": sha(b"int a;\n"), "size": 7}]}
    (root / "m/1.1.json").write_text(json.dumps(manifest))
    status = "pending" if defect == "status" else "done"
    spec_tail = 'verify_cmd = "python3 q.py --case V-001 --manifest m/1.1.json"\n\n[req.1]\n'
    # the receipt pinned the spec while the verify ran (status in_progress); the tree records the closed status
    pinned_spec = ('[task.1.1]\nstatus = "in_progress"\n' + spec_tail).encode()
    tree_spec = '[task.1.1]\nstatus = "' + status + '"\n' + ('touches = ["src/a.c"]\n' if defect == "spec-drift" else "") + spec_tail
    (root / "spec/hyperfide/spec.kvx").write_text(tree_spec)
    run("add", "-A")
    run("commit", "-qm", "base")
    head = git(root, "rev-parse", "HEAD").stdout.strip()
    run("checkout", "-q", "--orphan", "twin")
    run("commit", "-qm", "pre-rewrite twin")
    orphan = git(root, "rev-parse", "HEAD").stdout.strip()
    run("checkout", "-q", "-f", head)
    receipt = {"receipt_id": "r1", "task": "1.1", "selected_case_ids": ["V-001"], "outcome": "PASS",
               "diagnostics": [], "sealed_at": "2026-10-22T00:00:00Z",
               "source": {"commit": orphan if defect == "receipt-commit" else head},
               "manifest_sha256": sha((root / "m/1.1.json").read_bytes()),
               "inputs": [{"original_path": "src/a.c", "sha256": sha(b"int a;\n"), "size": 7},
                          {"original_path": "spec/hyperfide/spec.kvx", "sha256": sha(pinned_spec), "size": len(pinned_spec)}]}
    receipt["seal"] = sha(canonical(receipt))
    if defect == "seal":
        # content edited after sealing: the receipt still says PASS
        receipt["sealed_at"] = "2026-10-23T00:00:00Z"
    campaign = root / "artifacts/hyperfide/tasks/1.1/campaigns/c"
    (campaign / "receipts").mkdir(parents=True)
    (campaign / "checks").mkdir()
    if defect != "spec-copy":
        (campaign / "inputs" / sha(pinned_spec)).mkdir(parents=True)
        (campaign / "inputs" / sha(pinned_spec) / "spec.kvx").write_bytes(pinned_spec)
    data = canonical(receipt) + b"\n"
    (campaign / "receipts/r1.json").write_bytes(data)
    check = {"status": "FAIL" if defect == "checker" else "PASS", "receipt_sha256": sha(data)}
    (campaign / "checks/r1.json").write_text(json.dumps(check))
    index_commit = orphan if defect == "index" else head
    (root / "artifacts/hyperfide/tasks/1.1/evidence-index.json").write_text(
        json.dumps({"task": "1.1", "commit": index_commit, "requalified_on": index_commit, "exit_code": 0}))
    if defect == "drift":
        (root / "src/a.c").write_text("int b;\n")
    return root


def self_test():
    defects = ["status", "seal", "checker", "drift", "spec-drift", "spec-copy", "receipt-commit", "index"]
    base = Path(tempfile.mkdtemp(prefix="closure-check-"))
    errors = []
    try:
        for defect in ["good"] + defects:
            root = _fixture(base, defect)
            failures = check_task(root, (root / "spec/hyperfide/spec.kvx").read_text(),
                                  root / "artifacts/hyperfide/tasks", "1.1")
            if defect == "good" and failures:
                errors.append("good closure rejected: " + "; ".join(failures))
            if defect != "good" and not failures:
                errors.append("defect '" + defect + "' was not detected")
    finally:
        shutil.rmtree(base, ignore_errors=True)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="+", help="hyperfide task ids, e.g. 11.2 12.1")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--artifacts", help="artifacts/hyperfide/tasks directory to read")
    args = parser.parse_args()
    errors = self_test()
    if errors:
        for line in errors:
            print("FAIL self-test: " + line)
        return 1
    print("self-test: good closure accepted; 8 single-defect closures rejected")
    root = Path(args.root).resolve()
    artifacts = Path(args.artifacts) if args.artifacts else default_artifacts(root)
    spec_text = (root / "spec/hyperfide/spec.kvx").read_text()
    closed, open_ = [], []
    for task in args.ids:
        failures = check_task(root, spec_text, artifacts, task)
        if failures:
            open_.append(task)
            print("FAIL " + task + ": " + " | ".join(failures))
        else:
            closed.append(task)
            print("PASS " + task)
    print("closed %d/%d%s" % (len(closed), len(args.ids), (" (open: " + " ".join(open_) + ")") if open_ else ""))
    return 0 if not open_ else 1


if __name__ == "__main__":
    sys.exit(main())
