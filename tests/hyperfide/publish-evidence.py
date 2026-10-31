#!/usr/bin/env python3
"""Publish task evidence bundles to the artifact store and write the tracked receipts.

    python3 tests/hyperfide/publish-evidence.py --all          # every artifacts/hyperfide/tasks/<id>
    python3 tests/hyperfide/publish-evidence.py --task 26.4    # one task (repeatable)
    python3 tests/hyperfide/qualify.py --publish 26.4          # the same command for one task
    python3 tests/hyperfide/publish-evidence.py --all --dry-run

For each task it bundles the local evidence directory (evidence_store.bundle), passes the
bytes to publishEvidenceBundle (core/control-plane/dist/artifacts/objects.js), whose
artifact.object.put, artifact.manifest.commit and artifact.manifest.read calls go to the
control service's component 15.2 through `hyperfide authority invoke` (the store's write
credentials stay in the control service), reads the receipted bundle back from the store
with signed GETs, and only then writes tests/hyperfide/evidence-receipts/<task>.json.

Required: HF_ARTIFACT_S3_ENDPOINT, HF_ARTIFACT_S3_REGION, HF_ARTIFACT_S3_BUCKET,
HF_ARTIFACT_S3_ACCESS_KEY_ID, HF_ARTIFACT_S3_SECRET_ACCESS_KEY (read-back),
HF_ARTIFACT_ORGANISATION_ID and HYPERFIDE_TRANSPORT_CONFIG (an operator credential whose
run is in the control service's HF_ARTIFACT_ALLOWED_RUN_IDS; HF_EVIDENCE_RUN_ID when the
transport configuration names no run_id). Without them it refuses, lists every missing
name and prints what it would publish; it never skips silently.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evidence_store  # noqa: E402

COMPONENT = "15.2"
MODULE = "core/control-plane/dist/artifacts/objects.js"

# Each store call is one authenticated envelope; a refused or UNKNOWN outcome throws, so
# publishEvidenceBundle stops before a manifest names a chunk the store did not verify.
DRIVER = r"""
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const [moduleUrl,bundlePath,cg,organisation,run,task,commitsJson]=process.argv.slice(1);
const {publishEvidenceBundle}=await import(moduleUrl);
const store={async invoke(action,input){
 const payload=JSON.stringify({run_id:run,component:'15.2',action,input,expected_version:null,authority:null});
 const r=spawnSync(cg,['authority','invoke','--payload-file','-','--operation-id',randomUUID(),'--idempotency-key',randomUUID(),'--correlation-id',randomUUID()],{input:payload,encoding:'utf8',maxBuffer:8*1024*1024});
 let body=null;try{body=JSON.parse(r.stdout.trim().split('\n').pop());}catch{}
 if(r.status!==0||!body||body.ok!==true)throw new Error(action+' refused (exit '+r.status+'): '+((body&&JSON.stringify(body.error))||r.stderr.trim().slice(-600)||'no response'));
 return body.result;
}};
const commits=JSON.parse(commitsJson);
const record=await publishEvidenceBundle(store,{},{organisation_id:organisation,run_id:run},task,readFileSync(bundlePath),Object.keys(commits).length?commits:undefined);
process.stdout.write(JSON.stringify(record)+'\n');
"""


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def run_id():
    value = os.environ.get("HF_EVIDENCE_RUN_ID")
    if value:
        return value
    config = os.environ.get("HYPERFIDE_TRANSPORT_CONFIG")
    if config and Path(config).is_file():
        try:
            return json.loads(Path(config).read_text()).get("run_id")
        except (OSError, ValueError):
            return None
    return None


def missing_names():
    missing = evidence_store.missing_store_names()
    for name in ("HF_ARTIFACT_ORGANISATION_ID", "HYPERFIDE_TRANSPORT_CONFIG"):
        if not os.environ.get(name):
            missing.append(name)
    if not run_id():
        missing.append("HF_EVIDENCE_RUN_ID")
    return missing


def find_cg(root, explicit):
    if explicit:
        return Path(explicit)
    for name in ("hyperfide", "cg"):
        if os.access(root / name, os.X_OK):
            return root / name
    found = shutil.which("hyperfide")
    return Path(found) if found else None


def plan(root, tasks):
    rows = []
    for task in tasks:
        directory = root / evidence_store.TASKS_DIR / task
        if not evidence_store.TASK.fullmatch(task) or not directory.is_dir():
            rows.append({"task": task, "error": "no local evidence directory " + str(directory)})
            continue
        data = evidence_store.bundle(directory)
        existing = None
        try:
            existing = evidence_store.load_record(root, task)["content_digest"]
        except evidence_store.EvidenceUnavailable:
            pass
        except evidence_store.EvidenceIntegrityError as exc:
            existing = "invalid: " + str(exc)
        rows.append({"task": task, "content_digest": sha(data), "size_bytes": len(data), "commits": evidence_store.index_commits(data),
                     "receipt": "absent" if existing is None else "current" if existing == sha(data) else "replaced", "data": data})
    return rows


def publish_one(root, row, cg, module, organisation, run, scratch):
    task, data = row["task"], row["data"]
    bundle_path = scratch / (task + ".tar")
    bundle_path.write_bytes(data)
    result = subprocess.run(["node", "--input-type=module", "-e", DRIVER, module.as_uri(), str(bundle_path), str(cg), organisation, run, task, json.dumps(row["commits"])],
                            capture_output=True, text=True, timeout=3600)
    if result.returncode:
        raise RuntimeError("publishEvidenceBundle failed: " + result.stderr.strip()[-1500:])
    record = json.loads(result.stdout.strip().splitlines()[-1])
    evidence_store.validate_record(record, task)
    if record["content_digest"] != row["content_digest"]:
        raise evidence_store.EvidenceIntegrityError("store receipted a different bundle than the one published")
    # Read back what the receipt names before it is tracked: a clean clone resolves exactly this.
    if evidence_store.fetch_bundle(record) != data:
        raise evidence_store.EvidenceIntegrityError("bundle read back from the store differs from the published bytes")
    target = evidence_store.receipts_dir(root) / (task + ".json")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name("." + task + ".json.tmp")
    staging.write_text(json.dumps(record, indent=2) + "\n")
    os.replace(staging, target)
    return {"task": task, "status": "PUBLISHED", "receipt": str(target), "receipt_id": record["receipt"]["receipt_id"], "chunk_count": record["chunk_count"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--task", action="append")
    selector.add_argument("--all", action="store_true", help="every task directory under artifacts/hyperfide/tasks")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--cg", help="hyperfide executable for authority invoke (default ./hyperfide, ./cg, then PATH)")
    parser.add_argument("--module", help="compiled objects.js (default " + MODULE + ")")
    parser.add_argument("--dry-run", action="store_true", help="print the plan; publish nothing")
    parser.add_argument("--force", action="store_true", help="republish tasks whose tracked receipt already names the current bundle")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    if args.all:
        base = root / evidence_store.TASKS_DIR
        tasks = sorted((p.name for p in base.iterdir() if p.is_dir() and evidence_store.TASK.fullmatch(p.name)), key=lambda t: tuple(map(int, t.split(".")))) if base.is_dir() else []
    else:
        tasks = args.task
    rows = plan(root, tasks)
    summary = {"tasks": len(rows), "bytes": sum(r.get("size_bytes", 0) for r in rows), "to_publish": [r["task"] for r in rows if "error" not in r and (args.force or r["receipt"] != "current")],
               "current": [r["task"] for r in rows if r.get("receipt") == "current"], "errors": [r for r in rows if "error" in r]}
    will = ("publish " + str(len(summary["to_publish"])) + " task bundle(s) through component " + COMPONENT + " (artifact.object.put, artifact.manifest.commit, artifact.manifest.read), "
            "read each back from the store and write " + str(evidence_store.receipts_dir(root)) + "/<task>.json")
    if args.dry_run or not tasks or summary["errors"]:
        status = "PLAN" if args.dry_run and not summary["errors"] and tasks else "REFUSED"
        print(json.dumps({"status": status, "will": will, **summary, "missing": missing_names()}))
        return 0 if status == "PLAN" else 2
    missing = missing_names()
    if missing:
        print(json.dumps({"status": "REFUSED", "error": "artifact store publication needs " + ", ".join(missing), "missing": missing, "will": will, **summary}))
        print("publish-evidence: refused, missing " + ", ".join(missing), file=sys.stderr)
        return 2
    cg = find_cg(root, args.cg)
    module = Path(args.module).resolve() if args.module else root / MODULE
    if not cg or not os.access(cg, os.X_OK):
        print(json.dumps({"status": "REFUSED", "error": "no hyperfide executable for authority invoke (make, or --cg)"}))
        return 2
    if not module.is_file():
        print(json.dumps({"status": "REFUSED", "error": "compiled " + MODULE + " is absent (npm --prefix core/control-plane run build, or --module)"}))
        return 2
    organisation, run = os.environ["HF_ARTIFACT_ORGANISATION_ID"], run_id()
    results = [{"task": r["task"], "status": "CURRENT", "content_digest": r["content_digest"]} for r in rows if r["task"] not in summary["to_publish"]]
    with tempfile.TemporaryDirectory(prefix="hf-publish-evidence-") as scratch:
        for row in rows:
            if row["task"] not in summary["to_publish"]:
                continue
            try:
                results.append(publish_one(root, row, cg, module, organisation, run, Path(scratch)))
            except (evidence_store.EvidenceIntegrityError, evidence_store.EvidenceUnavailable, RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
                results.append({"task": row["task"], "status": "FAILED", "error": str(exc)})
    failed = [r for r in results if r["status"] == "FAILED"]
    print(json.dumps({"status": "FAILED" if failed else "PUBLISHED", "results": results}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
