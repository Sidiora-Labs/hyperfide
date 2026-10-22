#!/usr/bin/env python3
"""hyperfide-v21 3.13: the evidence cache, the dist stamp, the provisioner preflight and the 1.3 check.

- evidence_store.resolve() verifies a present artifacts cache against the tracked receipt record:
  a matching cache is verified, a tampered one is refused (with and without a store), a cache that
  only adds unpublished files to the receipted bundle is accepted once a loopback stub store shows
  it, and a cache with no receipt is unverified (refused when evidence is required).
- dist-stamp.mjs hashes the emitted dist tree: removing or hand-editing a dist file reads stale.
- bootstrap-host.mjs provisioner preflight lists two absent files in one refusal and warns, without
  blocking, when HF_SLICE_SOURCE_CONFIG is absent (decision D18).
- task 1.3's verify_cmd passes in a fresh copy of the tracked tree (no CLAUDE.md or AGENTS.md) and
  still fails when a present render output is stale."""
import hashlib, http.server, json, os, pathlib, re, shutil, subprocess, sys, tempfile, threading

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests/hyperfide"))
import evidence_store  # noqa: E402

TASK, ORG, RUN = "9.3", "7d0f9a52-6c0e-4b8e-9a51-3f1c2d4e5a61", "1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f9"
REGION, BUCKET = "stub-region-1", "stub-evidence"
IDS, FAILED = [], []


def expect(value, message="assertion failed"):
    if not value:
        raise AssertionError(message)


def check(name, fn):
    identity = "v21.3.13." + name
    IDS.append(identity)
    try:
        actual = fn() or "observed"
    except Exception as error:  # every failure is reported, none is swallowed
        actual = type(error).__name__ + ": " + str(error)
        FAILED.append(identity)
    print(json.dumps({"type": "assertion", "id": identity, "expected": "observed", "actual": actual}), flush=True)


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Store(http.server.BaseHTTPRequestHandler):
    """Serves receipted objects by path. Signatures are 1.2's concern; this stub only answers GETs."""
    objects = {}

    def log_message(self, *args):
        pass

    def do_GET(self):
        data = Store.objects.get(self.path)
        self.send_response(200 if data is not None else 404)
        self.send_header("content-length", str(len(data or b"")))
        self.end_headers()
        self.wfile.write(data or b"")


def publish(root, task_dir):
    """Writes the receipt record for the current cache and puts its manifest and chunk in the stub."""
    data = evidence_store.bundle(task_dir)
    chunk = {"sequence": 0, "artifact_id": "0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b", "digest": sha(data), "size_bytes": str(len(data)), "offset_bytes": "0"}
    manifest = json.dumps({"schema_version": 1, "kind": "chunk-manifest", "organisation_id": ORG, "run_id": RUN, "expected_chunks": 1,
                           "total_size_bytes": str(len(data)), "content_digest": sha(data), "complete": True, "truncated": False,
                           "missing_ranges": [], "chunks": [chunk]}).encode()
    receipt = {"schema_version": 1, "organisation_id": ORG, "run_id": RUN, "artifact_id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
               "digest": sha(manifest), "size_bytes": str(len(manifest)), "storage_backend": "s3-v1",
               "storage_key": evidence_store.key_of(ORG, RUN, sha(manifest), True), "completed_at": "2026-10-22T12:00:00.000Z"}
    receipt["receipt_id"] = evidence_store.receipt_id(receipt)
    record = {"schema_version": 1, "kind": "hyperfide-evidence-receipt", "task": TASK, "bundle_format": "tar", "content_digest": sha(data),
              "total_size_bytes": str(len(data)), "chunk_count": 1, "retention_class": "RELEASE", "receipt": receipt}
    path = root / evidence_store.RECEIPTS_DIR / (TASK + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))
    Store.objects["/" + BUCKET + "/" + receipt["storage_key"]] = manifest
    Store.objects["/" + BUCKET + "/" + evidence_store.key_of(ORG, RUN, chunk["digest"])] = data
    return record


def evidence_checks(tmp):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Store)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    store_env = {"HF_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:" + str(server.server_address[1]), "HF_ARTIFACT_ALLOW_LOOPBACK_HTTP": "1",
                 "HF_ARTIFACT_S3_REGION": REGION, "HF_ARTIFACT_S3_BUCKET": BUCKET, "HF_ARTIFACT_S3_ACCESS_KEY_ID": "AKIASTUBONLY",
                 "HF_ARTIFACT_S3_SECRET_ACCESS_KEY": "stub-secret-not-a-credential"}
    for key in [k for k in os.environ if k.startswith(("HF_ARTIFACT_", "HYPERFIDE_EVIDENCE_"))]:
        del os.environ[key]
    root = tmp / "evidence"
    task_dir = root / evidence_store.TASKS_DIR / TASK
    (task_dir / "receipts").mkdir(parents=True)
    (task_dir / "receipts/0001.json").write_text('{"sequence":1}\n')
    (task_dir / "manifest.json").write_text('{"campaign":"probe"}\n')

    def refused(fn, needle):
        try:
            fn()
        except evidence_store.EvidenceIntegrityError as error:
            expect(needle in str(error), "refused for the wrong reason: " + str(error))
            return "refused: " + str(error)[:120]
        raise AssertionError("not refused")

    def unreceipted():
        out = evidence_store.resolve(root, TASK)
        expect(out["status"] == "LOCAL_CACHE" and out["verified"] is False and "unverified" in out["warning"], out)
        try:
            evidence_store.resolve(root, TASK, required=True)
        except evidence_store.EvidenceUnavailable as error:
            expect("no receipt to verify against" in str(error), str(error))
            return "warned, and refused when required"
        raise AssertionError("an unreceipted cache satisfied required evidence")
    check("cache.unreceipted-is-unverified", unreceipted)

    state = {}

    def matching():
        state["record"] = publish(root, task_dir)
        out = evidence_store.resolve(root, TASK, required=True)
        expect(out["status"] == "LOCAL_CACHE" and out["verified"] is True and out["content_digest"] == state["record"]["content_digest"], out)
    check("cache.matching-is-verified", matching)

    original = (task_dir / "manifest.json").read_bytes()
    (task_dir / "manifest.json").write_bytes(original.replace(b"probe", b"forged"))
    check("cache.tampered-refused-without-store", lambda: refused(lambda: evidence_store.resolve(root, TASK), "store cannot show it is only ahead"))
    os.environ.update(store_env)
    check("cache.tampered-refused-with-store", lambda: refused(lambda: evidence_store.resolve(root, TASK), "stale or tampered"))
    (task_dir / "manifest.json").write_bytes(original)

    def removed():
        (task_dir / "receipts/0001.json").unlink()
        try:
            return refused(lambda: evidence_store.resolve(root, TASK), "stale or tampered")
        finally:
            (task_dir / "receipts/0001.json").write_text('{"sequence":1}\n')
    check("cache.stale-refused", removed)

    def ahead():
        (task_dir / "receipts/0002.json").write_text('{"sequence":2}\n')
        try:
            out = evidence_store.resolve(root, TASK)
            expect(out["status"] == "LOCAL_CACHE" and out.get("ahead_of_receipt") is True and "unpublished" in out["warning"], out)
        finally:
            (task_dir / "receipts/0002.json").unlink()
    check("cache.ahead-of-receipt-accepted", ahead)

    def absent_still_resolves():
        shutil.rmtree(task_dir)
        out = evidence_store.resolve(root, TASK, required=True)
        expect(out["status"] == "RESOLVED" and (task_dir / "manifest.json").read_bytes() == original, out)
        expect(evidence_store.resolve(root, TASK)["verified"] is True, "a restored cache does not verify")
    check("cache.absent-resolves-and-verifies", absent_still_resolves)
    for key in store_env:
        del os.environ[key]
    server.shutdown()


def stamp_checks(tmp):
    service = tmp / "service"
    (service / "src/recovery").mkdir(parents=True)
    (service / "dist/recovery").mkdir(parents=True)
    (service / "package.json").write_text('{"name":"probe"}\n')
    (service / "src/recovery/bootstrap_fence.ts").write_text("export const fence = 1;\n")
    (service / "dist/recovery/bootstrap_fence.js").write_text("export const fence = 1;\n")
    (service / "dist/index.js").write_text("export {};\n")
    tool = ROOT / "deploy/hyperfide/dist-stamp.mjs"

    def stamp(mode):
        r = subprocess.run(["node", str(tool), mode, str(service)], capture_output=True, text=True, timeout=60)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1]), r.stderr

    def fresh():
        code, out, _ = stamp("write")
        expect(code == 0 and out["dist_files"] == 2 and out["dist_digest"].startswith("sha256:"), out)
        code, out, err = stamp("check")
        expect(code == 0 and out["fresh"] is True, out)
    check("stamp.fresh", fresh)

    fence = service / "dist/recovery/bootstrap_fence.js"

    def removed():
        fence.rename(service / "fence.kept")
        try:
            code, out, err = stamp("check")
            expect(code == 1 and out["fresh"] is False and out["code"] == "DIST_STALE" and out["reason"] == "dist", out)
            expect("the files its build emitted" in err, err)
        finally:
            (service / "fence.kept").rename(fence)
        code, out, _ = stamp("check")
        expect(code == 0, "restoring the file did not restore freshness: " + json.dumps(out))
    check("stamp.removed-dist-file-is-stale", removed)

    def edited():
        fence.write_text("export const fence = 2;\n")
        try:
            code, out, _ = stamp("check")
            expect(code == 1 and out["reason"] == "dist", out)
        finally:
            fence.write_text("export const fence = 1;\n")
    check("stamp.hand-edited-dist-file-is-stale", edited)

    def legacy():
        path = service / "dist/.source-digest.json"
        value = json.loads(path.read_text())
        del value["dist_digest"]
        path.write_text(json.dumps(value))
        code, out, _ = stamp("check")
        expect(code == 1 and out["reason"] == "dist", "a stamp without a dist digest vouched for dist: " + json.dumps(out))
    check("stamp.legacy-stamp-is-stale", legacy)


def preflight_checks(tmp):
    journal = tmp / "journal"
    journal.mkdir(mode=0o700)
    identity = tmp / "identity.json"
    identity.write_text("{}")
    credential = tmp / "credential.json"
    credential.write_text("{}")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HYPERFIDE_", "HF_"))}
    env.update(HYPERFIDE_REQUIRE_SYNC_REPLICA="0", HYPERFIDE_DEPLOYMENT_ID="11111111-1111-4111-8111-111111111111",
               HYPERFIDE_AUTHORITY_JOURNAL_DIR=str(journal), HYPERFIDE_SPEC_REVISION="fixture", HF_IDENTITY_CONFIG_FILE=str(identity),
               HYPERFIDE_PROVISIONER_LISTEN_HOST="127.0.0.1", HYPERFIDE_PROVISIONER_LISTEN_PORT="8443",
               HYPERFIDE_PROVISIONER_PRIMARY_DATABASE_URL="postgresql://fixture@localhost/fixture",
               HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE=str(tmp / "fence.json"), HYPERFIDE_POOL_CONFIG=str(tmp / "pools.json"),
               HF_RAILWAY_CONFIG=str(tmp / "railway.json"),
               HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(tmp / "absent-worker.json"), HF_CREDENTIAL_CONFIG_FILE=str(tmp / "absent-credential.json"))

    def preflight(environment):
        r = subprocess.run(["node", str(ROOT / "deploy/hyperfide/bootstrap-host.mjs"), "--preflight", "provisioner"], cwd=ROOT, env=environment,
                           capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout)
        expect(out["services_started"] is False, out)
        return r.returncode, out, r.stderr

    def two_missing():
        code, out, err = preflight(env)
        expect(code == 78 and out["outcome"] == "REFUSED" and out["error"]["code"] == "PROVISIONER_EXECUTOR_CONFIG_INVALID", out)
        expect(out["error"]["missing"] == [str(tmp / "absent-worker.json"), str(tmp / "absent-credential.json")], out)
        expect(any("HF_SLICE_SOURCE_CONFIG" in w for w in out.get("warnings", [])), "no slice-source warning: " + json.dumps(out))
        expect("hyperfide preflight warning: HF_SLICE_SOURCE_CONFIG absent" in err, err)
    check("preflight.two-missing-in-one-refusal-and-slice-warning", two_missing)

    def credential_present():
        code, out, _ = preflight(dict(env, HF_CREDENTIAL_CONFIG_FILE=str(credential)))
        expect(code == 78 and out["error"]["missing"] == [str(tmp / "absent-worker.json")], out)
    check("preflight.present-credential-file-not-listed", credential_present)

    def credential_relative():
        worker = tmp / "worker.json"
        worker.write_text("{}")
        code, out, _ = preflight(dict(env, HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(worker), HF_CREDENTIAL_CONFIG_FILE="credential.json"))
        expect(code == 78 and out["error"]["code"] == "CREDENTIAL_CONFIG_REQUIRED", out)
    check("preflight.credential-file-refused-when-unusable", credential_relative)

    def slice_source_set():
        code, out, err = preflight(dict(env, HF_SLICE_SOURCE_CONFIG=str(tmp / "object-store.json")))
        expect(code == 78 and "warnings" not in out and "HF_SLICE_SOURCE_CONFIG" not in err, out)
    check("preflight.no-warning-with-slice-source", slice_source_set)


def verify_cmd_13():
    text = (ROOT / "spec/hyperfide-v21/spec.kvx").read_text()
    block = text.split("[task.1.3]\n", 1)[1].split("\n[", 1)[0]
    return json.loads(re.search(r'^verify_cmd = (".*")$', block, re.M).group(1))


def workflow_checks(tmp):
    command = verify_cmd_13()
    fresh = tmp / "fresh"
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode().split("\0")
    for name in filter(None, listed):
        source, target = ROOT / name, fresh / name
        if not source.exists() and not source.is_symlink():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(os.readlink(source))
        elif source.is_file():
            shutil.copy2(source, target)

    def run():
        env = {k: v for k, v in os.environ.items() if k not in ("CG", "CG_FEATURE")}
        return subprocess.run(["sh", "-c", command], cwd=fresh, env=env, capture_output=True, text=True, timeout=1200)

    def passes_fresh():
        expect(not (fresh / "CLAUDE.md").exists() and not (fresh / "AGENTS.md").exists(), "the tracked tree carries render outputs")
        r = run()
        expect(r.returncode == 0, "1.3 verify_cmd failed in a fresh tree: " + (r.stdout + r.stderr)[-1500:])
        expect((fresh / "CLAUDE.md").is_file() and (fresh / "AGENTS.md").is_file(), "the fresh run did not render")
    check("workflow.verify-cmd-passes-fresh", passes_fresh)

    def stale_still_fails():
        claude = fresh / "CLAUDE.md"
        claude.write_text(claude.read_text() + "\nhand edit\n")
        r = run()
        expect(r.returncode != 0 and "stale" in (r.stdout + r.stderr), "a stale CLAUDE.md passed the 1.3 check")
    check("workflow.stale-output-still-fails", stale_still_fails)


def main():
    with tempfile.TemporaryDirectory(prefix="hf-v21-3-13-") as tmp:
        tmp = pathlib.Path(tmp)
        evidence_checks(tmp)
        stamp_checks(tmp)
        preflight_checks(tmp)
        workflow_checks(tmp)
    print(json.dumps({"type": "cleanup", "resources": [], "complete": True}), flush=True)
    print(("FAIL: " + ", ".join(FAILED)) if FAILED else "PASS: " + str(len(IDS)) + " assertions", file=sys.stderr)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
