"""Private, revision-bound receipts for the owner-supplied live SCM campaign."""
import importlib.util
from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from urllib.parse import quote, quote_plus

ROOT = Path(__file__).resolve().parents[3]
REGISTRY = ROOT / "tests/hyperfide/source-control/registry.json"
STORE_VARIABLES = (
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_REGION",
    "S3_BUCKET",
)
INPUT_POLICY = "Variable names and fixture identities only; no access values. Missing inputs remain UNRUN, never PASS."
EXIT_POLICY = "Return 0 only for a current REAL_S3 sparse PASS with no executed case failed; missing owner inputs remain UNRUN. Return 77 for an unexecuted sparse proof and 1 for any failed case."
OBJECT_CASES = {"SCM-002", "SCM-005", "SCM-010", "SCM-011", "SCM-018", "SCM-019"}
FAILOVER_CASES = {"SCM-002", "SCM-005", "SCM-018", "SCM-019"}
PROVIDER_CASES = {"SCM-014", "SCM-023", "SCM-026", "SCM-027", "SCM-028", "SCM-029"}
EXTRA_FIXTURES = {
    "SCM-015": ["authenticated GitHub CLI, untouched private canary repository, approved retention expiry and observed cleanup"],
    "SCM-016": ["retained owned GitHub import receipt, authenticated read-only GitHub fetch, actual local Git history and owned PostgreSQL import fixture"],
    "SCM-017": ["owned PostgreSQL, real local Git storage, kernel-isolated writer fences and atomic cutover/rollback fixture"],
    "SCM-020": ["completed growth matrix: cold unique content, directory fanout, history depth, independently measured source tier; pinned hardware, native source authority, isolated metadata/object scopes and fresh provider topology readback"],
    "SCM-021": ["completed 5000-workspace mixed-load and twenty-million logical-open admission campaigns; authoritative ledgers, native source authority, isolated metadata/object scopes, pinned hardware and measured provider topology"],
    "SCM-022": ["completed real-S3 72-hour endurance campaign, three daily revision inventories, credential renewal, independent real-worker revisions, fault receipts, measured provider topology and cleanup"],
    "SCM-023": ["built control service and CLI, pinned Chromium and desktop/tablet/mobile browser fixture, real signed native fleet candidate and independent Git readback"],
    "SCM-024": ["verifier, closure, release, campaign and status-contract conformance inventories plus specification-authoring validator"],
    "SCM-025": ["current complete layout receipt build/layout/0.9/receipt.json, runtime receipts 0.4 through 0.8, authorized layout ancestry, original Git baseline and rollback inventory"],
}


def store_environment(environment):
    """Map the task's five inputs to the names the real source backend reads."""
    mapped = dict(environment)
    missing = [name for name in STORE_VARIABLES if not environment.get(name)]
    for name in STORE_VARIABLES:
        if environment.get(name):
            mapped["HF_SOURCE_" + name] = environment[name]
    return mapped, missing


def redact(text, environment):
    values = set()
    for name, value in environment.items():
        if value and (name in STORE_VARIABLES or name.startswith(("HF_SOURCE_S3_", "HF_ARTIFACT_S3_"))):
            values.update((value, quote(value, safe=""), quote_plus(value), json.dumps(value)[1:-1]))
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "[REDACTED]")
    return text


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(text)
    path.chmod(0o600)


@contextmanager
def owned_sparse_processes():
    """Own and reap compiler helpers orphaned by the sparse host process."""
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("Sparse process cleanup requires Linux child-subreaper capability")
    children_path = Path("/proc/self/task") / str(os.getpid()) / "children"

    def children():
        return {int(pid) for pid in children_path.read_text().split()}

    original = children()
    try:
        yield
    finally:
        started = time.monotonic()
        signalled = set()
        while True:
            owned = children() - original
            if not owned:
                break
            for pid in owned:
                try:
                    reaped, _ = os.waitpid(pid, os.WNOHANG)
                    if reaped:
                        continue
                    if time.monotonic() - started >= 5:
                        os.kill(pid, signal.SIGKILL)
                    elif pid not in signalled:
                        os.kill(pid, signal.SIGTERM)
                        signalled.add(pid)
                except ProcessLookupError:
                    continue
            if time.monotonic() - started >= 10:
                raise RuntimeError("Sparse fixture left owned descendants after cleanup")
            time.sleep(0.02)


def postgres_fixture():
    configured = os.environ.get("HYPERFIDE_PG_BIN")
    paths = [Path(configured)] if configured else sorted(Path("/usr/lib/postgresql").glob("*/bin"))
    return next((path for path in reversed(paths)
                 if all((path / name).is_file() for name in ("initdb", "postgres", "pg_ctl"))
                 and shutil.which("runuser")), None)


def registrations():
    result = {}
    for path in sorted((REGISTRY.parent / "registrations").glob("*.json")):
        registration = json.loads(path.read_text())
        if registration.get("scope") == "full-case":
            for case in registration["cases"]:
                result.setdefault(case, []).append((path, registration))
    return result


def inventory(environment):
    registry = json.loads(REGISTRY.read_text())
    variants = registrations()
    database = postgres_fixture()
    records = {}
    for case, definition in registry["cases"].items():
        entries = variants.get(case, [])
        required = list(dict.fromkeys(name for _, entry in entries for name in entry["required_env"]
                                      if name != "HYPERFIDE_PG_BIN"))
        fixtures = list(definition["prerequisites"])
        fixtures.extend(EXTRA_FIXTURES.get(case, []))
        if case in OBJECT_CASES:
            required.extend(STORE_VARIABLES)
        if case in FAILOVER_CASES:
            fixtures.append("owned PostgreSQL 18 synchronous physical standby, promotion and physical backup restore; ordinary withpg does not supply this")
        if case in PROVIDER_CASES:
            fixtures.append("actual provider-backed execution and independently verified signed fleet evidence")
        required.append("HF_SOURCE_LIVE_CAMPAIGN_MANIFESTS")
        missing = [name for name in required if not environment.get(name)]
        if any("PostgreSQL" in item for item in fixtures) and database is None:
            missing.append("HYPERFIDE_PG_BIN (owned PostgreSQL server binaries)")
        if case in FAILOVER_CASES:
            missing.append("owned PostgreSQL 18 failover fixture and admitted synchronous durability profile")
        if case == "SCM-011" and not os.access("/dev/fuse", os.R_OK | os.W_OK):
            missing.append("/dev/fuse and admitted linux-fuse7-source-v1 mount capability")
        if case == "SCM-025" and not (ROOT / "build/layout/0.9/receipt.json").is_file():
            missing.append("current complete layout receipt build/layout/0.9/receipt.json")
        if not definition["full_assertion_ids"] or not entries:
            missing.append("complete registered assertion inventory")
        manifest_directory = environment.get("HF_SOURCE_LIVE_CAMPAIGN_MANIFESTS")
        manifests = []
        for path, entry in entries:
            manifest = Path(manifest_directory) / path.name if manifest_directory else None
            if manifest is None or not manifest.is_file():
                missing.append("signed campaign manifest for " + entry["variant"] + " (HF_SOURCE_LIVE_CAMPAIGN_MANIFESTS)")
            manifests.append(str(manifest) if manifest else "${HF_SOURCE_LIVE_CAMPAIGN_MANIFESTS}/" + path.name)
        registered_assertions = {name for _, entry in entries for name in entry["assertion_ids"]}
        inventory_supplied = bool(entries) and bool(definition["full_assertion_ids"]) and set(definition["full_assertion_ids"]) <= registered_assertions
        if not inventory_supplied:
            missing.append("complete registered assertion inventory covering registry full_assertion_ids")
        records[case] = {
            "driver": list(dict.fromkeys(entry["argv"][1] for _, entry in entries)),
            "commands": [shlex.join(entry["argv"]) for _, entry in entries],
            "registrations": [str(path.relative_to(ROOT)) for path, _ in entries],
            "variants": [entry["variant"] for _, entry in entries],
            "manifests": manifests,
            "variables": list(dict.fromkeys(required)),
            "fixtures": fixtures,
            "assertion_inventory": "tests/hyperfide/source-control/registry.json#cases." + case + ".full_assertion_ids",
            "assertion_inventory_supplied": inventory_supplied,
            "supplied": not missing,
            "status": "UNRUN",
            "missing": list(dict.fromkeys(missing)),
        }
    return records


def write_inventory(path, records, metadata):
    lines = []
    for section, values in [("task.22.37.31", metadata), *[("case." + case, row) for case, row in records.items()]]:
        lines.append("[" + section + "]")
        for key, value in values.items():
            lines.append(key + " = " + json.dumps(value, ensure_ascii=True))
        lines.append("")
    private_write(path, "\n".join(lines))


def run_record(command, environment, directory, revision, timeout):
    directory.mkdir(parents=True, mode=0o700)
    spec = importlib.util.spec_from_file_location("live_campaign_qualifier", ROOT / "tests/hyperfide/qualify.py")
    qualifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(qualifier)
    execution, stdout, stderr = qualifier.run_child(command, ROOT, timeout, environment)
    code = execution["exit_code"]
    if execution["timed_out"]:
        code = 124
    elif execution["leaked_descendants"] or execution["remaining_descendants"]:
        code = code or 1
    log = directory / "driver.log"
    private_write(log, redact((stdout + stderr).decode(errors="replace"), environment))
    receipt = {"revision": revision, "command": shlex.join(command), "cwd": "tools/hyperfide",
               "exit": code, "log": str(log), "status": "PASS" if code == 0 else "UNRUN" if code == 77 else "FAIL",
               "process_exit": execution["exit_code"], "timed_out": execution["timed_out"],
               "leaked_descendants": execution["leaked_descendants"], "remaining_descendants": execution["remaining_descendants"]}
    private_write(directory / "receipt.json", json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)
    return receipt


def run_campaign():
    environment, _ = store_environment(os.environ)
    database = postgres_fixture()
    if database is not None:
        environment["HYPERFIDE_PG_BIN"] = str(database)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    parent = Path(environment["HF_OUT_DIR"]) / "source-control" / "22.37.31" if environment.get("HF_OUT_DIR") else Path(tempfile.gettempdir()) / "hyperfide-live-campaign" / "22.37.31"
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix=revision + "-", dir=parent))
    records = inventory(environment)
    private_registry = json.loads(REGISTRY.read_text())
    metadata = {"revision": revision, "cwd": "tools/hyperfide", "build_ref": "${HF_RUN_DIR}/gates.jsonl#kind=build,revision=" + revision,
                "verification_ref": "${HF_RUN_DIR}/gates.jsonl#kind=verify,revision=" + revision,
                "registry": str(directory / "registry.json"), "input_policy": INPUT_POLICY, "exit_policy": EXIT_POLICY,
                "evidence_policy": "Private receipts only; S3 values redacted; a skip never qualifies a case."}
    sparse_directory = directory / "sparse"
    sparse_environment = dict(environment, HYPERFIDE_SOURCE_EVIDENCE_DIR=str(sparse_directory / "artifacts"))
    sparse = run_record(["python3", "tests/hyperfide/cases/source_control/sparse_live.py", "--actor"], sparse_environment, sparse_directory, revision, 600)
    if sparse["exit"] == 0:
        proof_path = sparse_directory / "artifacts/receipt.json"
        proof = json.loads(proof_path.read_text())
        if proof.get("backend") != "REAL_S3" or proof.get("status") != "PASS" or proof.get("revision") != revision:
            raise RuntimeError("Sparse driver did not produce a current REAL_S3 PASS receipt")
    metadata["sparse_receipt"] = str(sparse_directory / "receipt.json")
    metadata["sparse_status"] = sparse["status"]
    metadata["sparse_exit"] = sparse["exit"]
    metadata["sparse_missing"] = [name for name in STORE_VARIABLES if not environment.get(name)]
    failed = sparse["status"] == "FAIL"
    for case, row in records.items():
        private_registry["cases"][case]["status"] = row["status"]
        private_registry["cases"][case]["live_campaign_missing"] = row["missing"]
        if row["missing"]:
            print("UNRUN " + case + ": " + "; ".join(row["missing"]), flush=True)
            continue
        receipts = []
        for index, manifest in enumerate(row["manifests"]):
            variant_directory = directory / (case + "-" + str(index))
            command = ["python3", "tests/hyperfide/qualify.py", "--registry", "tests/hyperfide/source-control/registry.json", "--manifest", manifest, "--case", case,
                       "--output-dir", str(variant_directory / "campaign")]
            child_environment = dict(environment, HF_SOURCE_LIVE_CAMPAIGN_CHILD="1")
            receipts.append(run_record(command, child_environment, variant_directory, revision, 3600))
        row["status"] = "FAIL" if any(receipt["status"] == "FAIL" for receipt in receipts) else "UNRUN" if any(receipt["status"] == "UNRUN" for receipt in receipts) else "PASS"
        row["receipts"] = [str(directory / (case + "-" + str(index)) / "receipt.json") for index in range(len(receipts))]
        private_registry["cases"][case]["status"] = row["status"]
        private_registry["cases"][case]["live_campaign_receipts"] = row["receipts"]
        failed |= row["status"] == "FAIL"
    write_inventory(directory / "live-campaign.kvx", records, metadata)
    private_write(directory / "registry.json", json.dumps(private_registry, indent=2) + "\n")
    # The private result registry keeps build and verification on the same immutable input revision.
    private_write(parent / "latest.json", json.dumps({"revision": revision, "inventory": str(directory / "live-campaign.kvx"), "registry": str(directory / "registry.json"), "sparse_receipt": metadata["sparse_receipt"], "sparse_status": metadata["sparse_status"], "sparse_missing": metadata["sparse_missing"]}, indent=2) + "\n")
    print(json.dumps({"revision": revision, "inventory": str(directory / "live-campaign.kvx"), "registry": str(directory / "registry.json"), "sparse_status": sparse["status"]}), flush=True)
    if failed:
        return 1
    return 77 if sparse["exit"] == 77 else 0
