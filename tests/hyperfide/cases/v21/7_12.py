#!/usr/bin/env python3
"""Campaign capture records pinned executables by digest, not by copy (task 7.12).

A disposable workspace pins the running python3 executable and a 2 MB file outside the workspace,
plus a probe and a data file inside it. The real qualify.py and check-evidence.py run unmodified.
"""
import hashlib, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
TESTS = ROOT / "tests/hyperfide"
QUALIFY, CHECKER = TESTS / "qualify.py", TESTS / "check-evidence.py"
IDS, FAILED = [], []
sys.path.insert(0, str(TESTS))
import evidence_store  # noqa: E402

PROBE = 'import json\nprint(json.dumps({"type":"assertion","id":"refs.alpha","expected":1,"actual":1}))\nprint(json.dumps({"type":"cleanup","resources":[],"complete":True}))\n'


def expect(value, message="assertion failed"):
    if not value:
        raise AssertionError(message)


def check(name, fn):
    identity = "evidence.reference." + name
    IDS.append(identity)
    try:
        actual = fn() or "observed"
    except Exception as error:  # every failure is reported, none is swallowed
        actual = type(error).__name__ + ": " + str(error)
        FAILED.append(identity)
    print(json.dumps({"type": "assertion", "id": identity, "expected": "observed", "actual": actual}), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def pin(workspace, label):
    path = pathlib.Path(label) if pathlib.Path(label).is_absolute() else workspace / label
    data = path.read_bytes()
    return {"path": label, "sha256": sha(data), "size": len(data)}


def run_check(campaign):
    result = subprocess.run([sys.executable, str(CHECKER), "--campaign", str(campaign)], capture_output=True, text=True, timeout=120)
    return result.returncode, json.loads(result.stdout.strip().splitlines()[-1])


def rewrite_receipt(path, change):
    """Edit and reseal a receipt; the seal is unanchored, so only the re-digest can catch a forgery."""
    original = path.read_bytes()
    receipt = json.loads(original)
    change(receipt)
    receipt.pop("seal")
    receipt["seal"] = sha(canonical(receipt))
    path.chmod(0o644)
    path.write_bytes(canonical(receipt) + b"\n")
    return original


def restore(path, data):
    path.write_bytes(data)
    path.chmod(0o444)


def main():
    with tempfile.TemporaryDirectory(prefix="hf-v21-7-12-ws-") as ws, tempfile.TemporaryDirectory(prefix="hf-v21-7-12-out-") as out:
        workspace, outside = pathlib.Path(ws).resolve(), pathlib.Path(out).resolve()
        python = str(pathlib.Path(sys.executable).resolve())
        big = outside / "big.bin"
        big.write_bytes(os.urandom(2 * 1024 * 1024))
        (workspace / "probe.py").write_text(PROBE)
        (workspace / "data.txt").write_text("inside the workspace\n")
        (workspace / "registrations").mkdir()
        write_json(workspace / "registry.json", {"schema_version": 1, "cases": {"V-056": {"title": "reference records", "full_assertion_ids": []}},
                                                 "suites": {"contract": ["V-056"]}, "registration_glob": "registrations/*.json"})
        write_json(workspace / "registrations" / "7.12.json", {"schema_version": 1, "variant": "task:7.12", "task": "7.12", "scope": "task-component",
                                                                "cases": ["V-056"], "assertion_ids": ["refs.alpha"], "argv": [sys.executable, "probe.py"],
                                                                "timeout_seconds": 30, "required_env": [], "fixtures": ["data.txt"], "resources": [],
                                                                "source_files": ["probe.py"], "source_roots": ["."]})
        write_json(workspace / "manifest.json", {"schema_version": 1, "campaign_id": "refs-7-12", "registered_variant": "task:7.12", "scope": "task-component",
                                                  "case_ids": ["V-056"], "expected_assertion_ids": ["refs.alpha"], "approval": {"approved": True, "allowed_actions": []},
                                                  "inputs": [pin(workspace, label) for label in ("probe.py", "data.txt", python, str(big))],
                                                  "resources": [], "seed": 1, "policy": {}})
        campaign = workspace / "campaign"
        run = subprocess.run([sys.executable, str(QUALIFY), "--root", str(workspace), "--registry", str(workspace / "registry.json"),
                              "--manifest", str(workspace / "manifest.json"), "--output-dir", str(campaign), "--case", "V-056"],
                             capture_output=True, text=True, timeout=300)
        summary = json.loads(run.stdout.strip().splitlines()[-1]) if run.stdout.strip() else {}
        receipt_path = campaign / "receipts" / (str(summary.get("receipt_id")) + ".json")
        receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {}
        inputs = {item["original_path"]: item for item in receipt.get("inputs", [])}

        def qualified():
            expect(run.returncode == 0 and summary.get("status") == "PASS", "qualify did not PASS: " + run.stdout[-600:] + run.stderr[-600:])
            code, result = run_check(campaign)
            expect(code == 0 and result.get("checked") is True and "unverifiable_references" not in result, "check-evidence refused: " + json.dumps(result))
            return "receipt PASS, check-evidence checked"

        def references_not_copied():
            for label in (python, str(big)):
                record = inputs.get(label)
                expect(record is not None and record.get("kind") == "reference" and "path" not in record, "not a reference record: " + label)
                expect(set(record) == {"kind", "original_path", "sha256", "size"}, "reference record shape: " + json.dumps(record))
            stored = {sha(path.read_bytes()) for path in campaign.rglob("*") if path.is_file()}
            expect(inputs[python]["sha256"] not in stored and inputs[str(big)]["sha256"] not in stored, "campaign holds a copy of a referenced file")
            return "python " + str(inputs[python]["size"]) + " B and big.bin " + str(inputs[str(big)]["size"]) + " B referenced, no bytes stored"

        def one_record_per_input():
            sources = [item["original_path"] for item in receipt["source"]["files"]]
            expect(python not in sources and str(big) not in sources, "a pinned outside input is recorded twice")
            return "outside inputs absent from source records"

        def campaign_small():
            total = sum(path.stat().st_size for path in campaign.rglob("*") if path.is_file())
            expect(total < 1024 * 1024, "campaign is " + str(total) + " bytes")
            return "campaign " + str(total) + " bytes"

        def inside_copied():
            for label in ("probe.py", "data.txt"):
                record = inputs.get(label)
                expect(record and "kind" not in record and isinstance(record.get("path"), str), "workspace input is not a copied record: " + label)
                copy = campaign / record["path"]
                expect(copy.is_file() and copy.read_bytes() == (workspace / label).read_bytes(), "workspace input bytes not copied: " + label)
            return "probe.py and data.txt copied under inputs/"

        def tampered_digest_refused():
            def forge(value):
                for item in value["inputs"]:
                    if item["original_path"] == str(big):
                        item["sha256"] = "0" * 64
            saved = rewrite_receipt(receipt_path, forge)
            try:
                code, result = run_check(campaign)
            finally:
                restore(receipt_path, saved)
            expect(code != 0 and "reference digest/size mismatch" in result.get("error", ""), "forged reference digest accepted: " + json.dumps(result))
            return result["error"]

        def changed_original_refused():
            saved = big.read_bytes()
            big.write_bytes(saved[:-1] + bytes([saved[-1] ^ 1]))
            try:
                code, result = run_check(campaign)
            finally:
                big.write_bytes(saved)
            expect(code != 0 and "reference digest/size mismatch" in result.get("error", ""), "changed referenced original accepted: " + json.dumps(result))
            return result["error"]

        def absent_original_unverifiable():
            moved = outside / "big.moved"
            big.rename(moved)
            try:
                code, result = run_check(campaign)
            finally:
                moved.rename(big)
            expect(code == 0 and result.get("checked") is True and result.get("unverifiable_references") == [str(big)], "absent original not reported unverifiable: " + json.dumps(result))
            return "checked, unverifiable_references=" + json.dumps(result["unverifiable_references"])

        def workspace_reference_refused():
            def forge(value):
                for item in value["inputs"]:
                    if item["original_path"] == "data.txt":
                        item.pop("path")
                        item["kind"] = "reference"
            saved = rewrite_receipt(receipt_path, forge)
            try:
                code, result = run_check(campaign)
            finally:
                restore(receipt_path, saved)
            expect(code != 0 and "reference record names a workspace file" in result.get("error", ""), "workspace reference accepted: " + json.dumps(result))
            return result["error"]

        def copied_shape_still_valid():
            record = inputs[str(big)]
            relative = pathlib.Path("inputs") / record["sha256"] / big.name
            (campaign / relative).parent.mkdir(parents=True, exist_ok=True)
            (campaign / relative).write_bytes(big.read_bytes())

            def legacy(value):
                for item in value["inputs"]:
                    if item["original_path"] == str(big):
                        item.pop("kind")
                        item["path"] = relative.as_posix()
            saved = rewrite_receipt(receipt_path, legacy)
            try:
                code, result = run_check(campaign)
            finally:
                restore(receipt_path, saved)
                shutil.rmtree(campaign / "inputs" / record["sha256"])
            expect(code == 0 and result.get("checked") is True, "copied record of an outside file refused: " + json.dumps(result))
            return "copied record shape checked"

        def bundle_carries_references():
            data = evidence_store.bundle(campaign)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
                member = archive.extractfile("receipts/" + receipt_path.name).read()
                names = archive.getnames()
            expect(member == receipt_path.read_bytes(), "bundle changed the receipt bytes")
            expect(not any(inputs[str(big)]["sha256"] in name or inputs[python]["sha256"] in name for name in names), "bundle holds referenced bytes")
            return "bundle " + str(len(data)) + " bytes, receipt identical"

        check("qualified", qualified)
        check("not-copied", references_not_copied)
        check("one-record-per-input", one_record_per_input)
        check("campaign-under-1mb", campaign_small)
        check("workspace-input-copied", inside_copied)
        check("tampered-digest-refused", tampered_digest_refused)
        check("changed-original-refused", changed_original_refused)
        check("absent-original-unverifiable", absent_original_unverifiable)
        check("workspace-reference-refused", workspace_reference_refused)
        check("copied-shape-valid", copied_shape_still_valid)
        check("bundle-carries-references", bundle_carries_references)
        check("qualified-after-negatives", qualified)
    print(json.dumps({"type": "cleanup", "resources": [], "complete": True}), flush=True)
    print(("FAIL: " + ", ".join(FAILED)) if FAILED else "PASS: " + str(len(IDS)) + " assertions", file=sys.stderr)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
