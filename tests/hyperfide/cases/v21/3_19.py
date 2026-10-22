#!/usr/bin/env python3
"""Evidence receipts publish from the host; the release marker reads from the store (task 3.19).

A loopback stub speaks the s3-v1 object contract (path-style keys, SigV4 with a test-only key,
If-None-Match PUT, 404 for absence) and verifies every signature. No real bucket or credential
is involved. The host command tests/hyperfide/publish-evidence.py runs unmodified: it drives the
real publishEvidenceBundle compiled from objects.ts, whose store calls go through a `hyperfide
authority invoke` executable. Only that executable is a stand-in for the control service's
component 15.2: it keeps the PostgreSQL metadata half in a state file, returns the envelopes and
receipt binding of objects.ts, and writes the object bytes into the stub with real SigV4 PUTs.
Resolution, the release marker input (evidence_store.unit_receipt_input plus the real compiled
stageUnitReceipt) and 80_qualification_inputs.sh then run against those objects."""
import hashlib, hmac, http.server, json, os, pathlib, shutil, subprocess, sys, tempfile, threading

ROOT = pathlib.Path(__file__).resolve().parents[4]
TESTS = ROOT / "tests/hyperfide"
SERVICE = ROOT / "services/hyperfide"
PUBLISH, QUALIFY = TESTS / "publish-evidence.py", TESTS / "qualify.py"
ORG, RUN = "7d0f9a52-6c0e-4b8e-9a51-3f1c2d4e5a60", "1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8"
ACCESS, SECRET, REGION, BUCKET = "AKIASTUBONLY", "stub-secret-not-a-credential", "stub-region-1", "stub-evidence"
PINNED = "sha256:c6acb6ed761cd7cbb0663969ac302859875426e83e7068bff63f9571effb3869"
NAMES = ["HF_ARTIFACT_S3_ENDPOINT", "HF_ARTIFACT_S3_REGION", "HF_ARTIFACT_S3_BUCKET", "HF_ARTIFACT_S3_ACCESS_KEY_ID", "HF_ARTIFACT_S3_SECRET_ACCESS_KEY", "HF_ARTIFACT_ORGANISATION_ID", "HYPERFIDE_TRANSPORT_CONFIG", "HF_EVIDENCE_RUN_ID"]
IDS, FAILED = [], []
sys.path.insert(0, str(TESTS))
import evidence_store  # noqa: E402


def expect(value, message="assertion failed"):
    if not value:
        raise AssertionError(message)


def check(name, fn):
    identity = "evidence.publish." + name
    IDS.append(identity)
    try:
        actual = fn() or "observed"
    except Exception as error:  # every failure is reported, none is swallowed
        actual = type(error).__name__ + ": " + str(error)
        FAILED.append(identity)
    print(json.dumps({"type": "assertion", "id": identity, "expected": "observed", "actual": actual}), flush=True)


class Stub(http.server.BaseHTTPRequestHandler):
    objects, puts = {}, []

    def log_message(self, *args):
        pass

    def _authorised(self, body):
        auth = self.headers.get("authorization", "")
        try:
            credential = auth.split("Credential=")[1].split(",")[0]
            signed = auth.split("SignedHeaders=")[1].split(",")[0].split(";")
            signature = auth.split("Signature=")[1]
            access, day, region, service, terminal = credential.split("/")
        except (IndexError, ValueError):
            return False
        if access != ACCESS or region != REGION or service != "s3" or terminal != "aws4_request":
            return False
        payload = hashlib.sha256(body).hexdigest()
        if self.headers.get("x-amz-content-sha256") != payload or "host" not in signed:
            return False
        canonical = "\n".join([self.command, self.path, "", "".join(n + ":" + self.headers.get(n, "").strip() + "\n" for n in signed), ";".join(signed), payload])
        to_sign = "AWS4-HMAC-SHA256\n" + self.headers["x-amz-date"] + "\n" + day + "/" + region + "/s3/aws4_request\n" + hashlib.sha256(canonical.encode()).hexdigest()
        key = ("AWS4" + SECRET).encode()
        for part in (day, region, "s3", "aws4_request"):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        return hmac.compare_digest(hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest(), signature)

    def _reply(self, status, body=b""):
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorised(b""):
            return self._reply(403)
        data = Stub.objects.get(self.path)
        self._reply(404) if data is None else self._reply(200, data)

    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if not self._authorised(body):
            return self._reply(403)
        if self.headers.get("if-none-match") == "*" and self.path in Stub.objects:
            return self._reply(412)
        Stub.objects[self.path] = body
        Stub.puts.append(self.path)
        self._reply(200)


# Stand-in for `hyperfide authority invoke` reaching component 15.2: metadata in a state file,
# envelopes and receipt binding as ArtifactStore returns them, bytes PUT into the stub.
FAKE = r'''#!/usr/bin/env python3
import datetime, hashlib, json, os, sys, uuid, urllib.error, urllib.request
sys.path.insert(0, os.environ["FAKE_TESTS"])
import evidence_store as es
args = sys.argv[1:]
if args[:4] != ["authority", "invoke", "--payload-file", "-"] or "--operation-id" not in args:
    print(json.dumps({"protocol_version": 1, "ok": False, "error": {"code": "INVALID_ARGS"}})); sys.exit(1)
operation = args[args.index("--operation-id") + 1]
payload = json.loads(sys.stdin.read())
path = os.environ["FAKE_STATE"]
state = json.load(open(path)) if os.path.exists(path) else {"rows": {}, "calls": []}
action, value = payload["action"], payload["input"]
state["calls"].append({"action": action, "component": payload["component"], "run_id": payload["run_id"], "retention_class": value.get("retention_class")})
sha = lambda b: "sha256:" + hashlib.sha256(b).hexdigest()
def reply(ok, result=None, error=None, code=0):
    json.dump(state, open(path, "w"))
    body = {"protocol_version": 1, "ok": ok, "operation_id": operation, "id": operation}
    body.update({"result": result} if ok else {"error": error})
    print(json.dumps(body)); sys.exit(code)
if payload["component"] != "15.2" or payload["run_id"] != value.get("run_id") or value.get("organisation_id") != os.environ["FAKE_ORG"]:
    reply(False, error={"code": "ARTIFACT_SCOPE_DENIED"}, code=1)
def store(data, manifest, policy):
    digest = sha(data)
    for row in state["rows"].values():
        if row["digest"] == digest:
            return row
    key = es.key_of(value["organisation_id"], value["run_id"], digest, manifest)
    try:
        urllib.request.urlopen(es.signed_request(es._config(), "PUT", key, data, {"if-none-match": "*"}), timeout=10).read()
    except urllib.error.HTTPError as exc:
        if exc.code != 412:
            reply(False, error={"code": "ARTIFACT_BACKEND_REJECTED"}, code=1)
    now = datetime.datetime.now(datetime.timezone.utc)
    row = {"organisation_id": value["organisation_id"], "run_id": value["run_id"], "id": str(uuid.uuid4()), "digest": digest, "size_bytes": str(len(data)),
           "storage_backend": "s3-v1", "storage_key": key, "completed_at": now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000), "retention_class": policy}
    state["rows"][row["id"]] = row
    return row
def receipt(row):
    binding = {"schema_version": 1, "organisation_id": row["organisation_id"], "run_id": row["run_id"], "artifact_id": row["id"], "digest": row["digest"], "size_bytes": row["size_bytes"],
               "storage_backend": row["storage_backend"], "storage_key": row["storage_key"], "completed_at": row["completed_at"]}
    binding["receipt_id"] = es.receipt_id(binding)
    if os.environ.get("FAKE_FORGE") == "1":
        binding["completed_at"] = "2020-01-01T00:00:00.000Z"
    return binding
def envelope(row, **extra):
    return {"outcome": "SUCCEEDED", "availability": "VERIFIED", "artifact": {"artifact_id": row["id"], "retention_class": row["retention_class"]}, "receipt": receipt(row), "authority": "NONE", "live_qualification": "NOT_EVALUATED", **extra}
if action == "artifact.object.put":
    import base64
    data = base64.b64decode(value["data_base64"])
    if sha(data) != value["digest"] or len(data) > 256 * 1024:
        reply(False, error={"code": "ARTIFACT_INTEGRITY"}, code=1)
    reply(True, envelope(store(data, False, value["retention_class"])))
if action == "artifact.manifest.commit":
    for chunk in value["chunks"]:
        row = state["rows"].get(chunk["artifact_id"])
        if not row or row["digest"] != chunk["digest"] or row["size_bytes"] != chunk["size_bytes"]:
            reply(False, error={"code": "ARTIFACT_MANIFEST_INVALID"}, code=1)
    manifest = {"schema_version": 1, "kind": "chunk-manifest", "organisation_id": value["organisation_id"], "run_id": value["run_id"], "expected_chunks": value["expected_chunks"],
                "total_size_bytes": value["total_size_bytes"], "content_digest": value["content_digest"], "complete": True, "truncated": False, "missing_ranges": [],
                "chunks": [{k: c[k] for k in ("sequence", "artifact_id", "digest", "size_bytes", "offset_bytes")} for c in value["chunks"]]}
    row = store(json.dumps(manifest, separators=(",", ":")).encode(), True, value["retention_class"])
    row["manifest"] = manifest
    reply(True, envelope(row, manifest_digest=row["digest"], content_digest=manifest["content_digest"], chunk_count=len(manifest["chunks"])))
if action == "artifact.manifest.read":
    row = state["rows"][value["artifact_id"]]
    reply(True, envelope(row, manifest=row["manifest"], manifest_digest=row["digest"], content_digest=row["manifest"]["content_digest"], chunk_count=len(row["manifest"]["chunks"])))
reply(False, error={"code": "ARTIFACT_INPUT_INVALID"}, code=1)
'''


def unit_bytes(mapped_commit):
    """The real 26.4 evidence index when this host holds it (gitignored, read only), else a fixture."""
    common = pathlib.Path(subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or ROOT / ".git")
    for candidate in (ROOT / "artifacts/hyperfide/tasks/26.4/evidence-index.json", common.parent / "artifacts/hyperfide/tasks/26.4/evidence-index.json"):
        if candidate.is_file() and evidence_store._sha(candidate.read_bytes()) == PINNED:
            return candidate.read_bytes(), True
    return json.dumps({"task": "26.4", "commit": mapped_commit, "requalified_on": mapped_commit, "fixture": True}).encode(), False


def run(argv, env, cwd=None, timeout=600):
    result = subprocess.run(argv, cwd=cwd or ROOT, env=env, capture_output=True, text=True, timeout=timeout)
    lines = result.stdout.strip().splitlines()
    try:
        out = json.loads(lines[-1]) if lines else {}
    except ValueError:
        out = {"raw": result.stdout[-1500:]}
    return result.returncode, out, result.stdout + result.stderr


def main():
    refs = json.loads((TESTS / "evidence-refs.json").read_text())["refs"]
    mapped = next(r["commit"] for r in refs if r["task"] == "26.4")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="hf-v21-3-19-") as tmp:
        tmp = pathlib.Path(tmp)
        base = tmp / "host"
        tasks = base / "artifacts/hyperfide/tasks"
        index, real_marker = unit_bytes(mapped)
        (tasks / "26.4").mkdir(parents=True)
        (tasks / "26.4/evidence-index.json").write_bytes(index)
        # 9.9 has no refs/evidence entry and enough ballast to span several s3-v1 objects.
        (tasks / "9.9/campaigns").mkdir(parents=True)
        (tasks / "9.9/evidence-index.json").write_text(json.dumps({"task": "9.9", "commit": mapped, "requalified_on": mapped}))
        (tasks / "9.9/campaigns/ballast.bin").write_bytes(hashlib.sha256(b"seed").digest() * 20000)
        receipts = base / evidence_store.RECEIPTS_DIR
        fake = tmp / "bin/hyperfide"
        fake.parent.mkdir()
        fake.write_text(FAKE)
        fake.chmod(0o755)
        transport = tmp / "transport.json"
        transport.write_text(json.dumps({"origin": "https://control.invalid", "key_path": "/nonexistent", "run_id": RUN}))
        state_file = tmp / "state.json"
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("HF_ARTIFACT_", "HYPERFIDE_EVIDENCE_", "HF_EVIDENCE_", "HYPERFIDE_TRANSPORT_", "HYPERFIDE_RELEASE_"))}
        env = dict(clean, HF_ARTIFACT_S3_ENDPOINT="http://127.0.0.1:" + str(server.server_address[1]), HF_ARTIFACT_ALLOW_LOOPBACK_HTTP="1", HF_ARTIFACT_S3_REGION=REGION,
                   HF_ARTIFACT_S3_BUCKET=BUCKET, HF_ARTIFACT_S3_ACCESS_KEY_ID=ACCESS, HF_ARTIFACT_S3_SECRET_ACCESS_KEY=SECRET, HF_ARTIFACT_ORGANISATION_ID=ORG,
                   HYPERFIDE_TRANSPORT_CONFIG=str(transport), FAKE_STATE=str(state_file), FAKE_TESTS=str(TESTS), FAKE_ORG=ORG)
        compiled = tmp / "ts"
        state = {}

        def compile_modules():
            r = subprocess.run([str(SERVICE / "node_modules/.bin/tsc"), "--ignoreConfig", "--outDir", str(compiled / "dist"), "--rootDir", str(SERVICE / "src"), "--module", "NodeNext", "--moduleResolution", "NodeNext",
                                "--target", "ES2023", "--types", "node", "--strict", "--skipLibCheck", str(SERVICE / "src/artifacts/objects.ts"), str(SERVICE / "src/deployment/releases.ts")],
                               cwd=SERVICE, capture_output=True, text=True, timeout=900)
            expect(r.returncode == 0, "objects.ts and releases.ts did not compile: " + r.stdout[-1500:] + r.stderr[-500:])
            (compiled / "package.json").write_text('{"type":"module"}')
            (compiled / "node_modules").symlink_to(SERVICE / "node_modules", target_is_directory=True)
            state["module"] = compiled / "dist/artifacts/objects.js"
        check("compile", compile_modules)
        publish = [sys.executable, str(PUBLISH), "--root", str(base), "--cg", str(fake), "--module", str(state.get("module", compiled / "dist/artifacts/objects.js"))]

        def missing_variables_refused():
            code, out, text = run(publish + ["--task", "26.4"], dict(clean, FAKE_STATE=str(state_file), FAKE_TESTS=str(TESTS), FAKE_ORG=ORG))
            expect(code == 2 and out.get("status") == "REFUSED" and out.get("missing") == NAMES, "missing variables were not all listed: " + text[-800:])
            expect("publish 1 task bundle" in out.get("will", "") and "refused, missing HF_ARTIFACT_S3_ENDPOINT" in text, "refusal does not say what it would do: " + text[-800:])
            code, out, _ = run([sys.executable, str(QUALIFY), "--root", str(base), "--publish", "26.4"], dict(clean))
            expect(code == 2 and out.get("missing") == NAMES, "qualify.py --publish did not refuse the same way: " + json.dumps(out))
            code, out, _ = run([sys.executable, str(PUBLISH), "--root", str(base), "--all", "--dry-run"], dict(clean))
            expect(code == 0 and out.get("status") == "PLAN" and out.get("to_publish") == ["9.9", "26.4"] and out.get("missing") == NAMES, "dry run plan wrong: " + json.dumps(out))
            expect(not receipts.exists() and not state_file.exists() and not Stub.objects, "a refused publish touched the store or wrote a receipt")
            return "refused naming " + str(len(NAMES)) + " variables"
        check("missing-variable-refused", missing_variables_refused)

        def forging_store_refused():
            code, out, text = run(publish + ["--task", "26.4"], dict(env, FAKE_FORGE="1"))
            expect(code == 1 and out["results"][0]["status"] == "FAILED" and "receipt identity differs from its binding" in out["results"][0]["error"], "forged store receipt was accepted: " + text[-800:])
            expect(not (receipts / "26.4.json").exists(), "a forged store receipt was written")
        check("forged-store-receipt-refused", forging_store_refused)

        def publish_all():
            Stub.puts.clear()
            state_file.unlink(missing_ok=True)
            code, out, text = run(publish + ["--all"], env)
            expect(code == 0 and out.get("status") == "PUBLISHED", "publish failed: " + text[-1500:])
            results = {r["task"]: r for r in out["results"]}
            expect(set(results) == {"9.9", "26.4"} and results["9.9"]["chunk_count"] >= 2, "unexpected publication: " + json.dumps(out))
            calls = json.loads(state_file.read_text())["calls"]
            actions = [c["action"] for c in calls]
            expect(actions.count("artifact.manifest.commit") == 2 and actions.count("artifact.manifest.read") == 2 and actions.count("artifact.object.put") == results["9.9"]["chunk_count"] + results["26.4"]["chunk_count"],
                   "unexpected store call sequence: " + str(actions))
            expect(all(c["component"] == "15.2" and c["run_id"] == RUN for c in calls) and all(c["retention_class"] == "RELEASE" for c in calls if c["action"] != "artifact.manifest.read"), "calls left component 15.2, the run or RELEASE retention")
            record = json.loads((receipts / "26.4.json").read_text())
            expect(record["evidence_commits"] == {"commit": mapped, "requalified_on": mapped} and record["receipt"]["organisation_id"] == ORG, "receipt record lacks the evidence commits")
            code, again, _ = run(publish + ["--all"], env)
            expect(code == 0 and {r["status"] for r in again["results"]} == {"CURRENT"}, "a current receipt was republished: " + json.dumps(again))
            return "published " + str(len(Stub.puts)) + " signed objects"
        check("publish-into-fixture-store", publish_all)

        clean_root = tmp / "clone"
        (clean_root / evidence_store.RECEIPTS_DIR).parent.mkdir(parents=True)
        shutil.copytree(receipts, clean_root / evidence_store.RECEIPTS_DIR)
        resolve = "import json,sys;sys.path.insert(0,sys.argv[1]);import evidence_store as e\ntry:print(json.dumps(e.resolve(sys.argv[2],sys.argv[3])))\nexcept Exception as x:print(json.dumps({'status':'REFUSED','error':str(x)}))"

        def resolves_on_clean_tree():
            for task in ("26.4", "9.9"):
                code, out, text = run([sys.executable, "-I", "-c", resolve, str(TESTS), str(clean_root), task], env)
                expect(out.get("status") == "RESOLVED", "receipt did not resolve on a clean tree: " + text[-800:])
                for path in (tasks / task).rglob("*"):
                    if path.is_file():
                        expect((clean_root / "artifacts/hyperfide/tasks" / task / path.relative_to(tasks / task)).read_bytes() == path.read_bytes(), "resolved bytes differ for " + str(path))
            shutil.rmtree(clean_root / "artifacts")
        check("receipt-resolves-on-clean-tree", resolves_on_clean_tree)

        def forged_receipt_refused():
            path = clean_root / evidence_store.RECEIPTS_DIR / "26.4.json"
            original = path.read_text()
            try:
                for mutate, needle in ((lambda r: r["receipt"].__setitem__("completed_at", "2020-01-01T00:00:00.000Z"), "receipt identity differs from its binding"),
                                       (lambda r: r.__setitem__("evidence_commits", {"commit": "1" * 40}), "evidence commits differ from the bundled evidence index")):
                    record = json.loads(original)
                    mutate(record)
                    path.write_text(json.dumps(record))
                    _, out, text = run([sys.executable, "-I", "-c", resolve, str(TESTS), str(clean_root), "26.4"], env)
                    expect(out.get("status") == "REFUSED" and needle in out.get("error", ""), "forged receipt was not refused: " + text[-600:])
                    expect(not (clean_root / "artifacts/hyperfide/tasks/26.4").exists(), "a refused receipt left a cache")
            finally:
                path.write_text(original)
        check("forged-receipt-refused", forged_receipt_refused)

        stage_js = "const [m,stage,receipt,source]=process.argv.slice(1);const {stageUnitReceipt}=await import(m);try{console.log(JSON.stringify(await stageUnitReceipt(stage,receipt,source)));}catch(e){console.log(JSON.stringify({error:e.message}));}"
        marker = "import json,sys;sys.path.insert(0,sys.argv[1]);import evidence_store as e\ntry:\n p,s=e.unit_receipt_input(sys.argv[2],sys.argv[3]);print(json.dumps({'path':str(p) if p else None,'source':s}))\nexcept Exception as x:print(json.dumps({'error':str(x)}))"

        def release_marker_from_store():
            expect("evidence_store.unit_receipt_input(root,temp,override)" in (ROOT / "scripts/release.sh").read_text(), "release.sh does not take the marker input from unit_receipt_input")
            expect(not (clean_root / "artifacts").exists(), "clean tree has artifacts/")
            scratch = tmp / "release-scratch"
            _, out, text = run([sys.executable, "-I", "-c", marker, str(TESTS), str(clean_root), str(scratch)], env)
            expect(out.get("source") == "store" and pathlib.Path(out["path"]).read_bytes() == index, "marker input was not read from the store: " + text[-600:])
            expect(not (clean_root / "artifacts").exists(), "reading the marker wrote a cache")
            stage = tmp / "stage"
            stage.mkdir()
            _, staged, text = run(["node", "--input-type=module", "-e", stage_js, (compiled / "dist/deployment/releases.js").as_uri(), str(stage), out["path"], out["source"]], env)
            if real_marker:
                expect(staged.get("staged") is True and staged.get("source") == "store" and evidence_store._sha((stage / "share/hyperfide/qualified/26.4.json").read_bytes()) == PINNED,
                       "stageUnitReceipt did not stage the store marker: " + text[-600:])
                result = "real 26.4 marker staged from the store"
            else:
                expect("from store differs from the pinned 26.4 receipt" in staged.get("error", ""), "fixture marker bytes did not reach stageUnitReceipt: " + text[-600:])
                result = "fixture marker reached stageUnitReceipt from the store (pinned bytes absent on this host)"
            _, out, _ = run([sys.executable, "-I", "-c", marker, str(TESTS), str(clean_root), str(scratch)], clean)
            expect("tracked receipt but the store cannot serve it" in out.get("error", "") and "HF_ARTIFACT_S3_ENDPOINT" in out["error"], "receipted marker without a store was not refused: " + json.dumps(out))
            bare = tmp / "bare"
            bare.mkdir()
            _, out, _ = run([sys.executable, "-I", "-c", marker, str(TESTS), str(bare), str(scratch)], clean)
            expect(out == {"path": None, "source": "absent"}, "no receipt and no cache should be absent: " + json.dumps(out))
            return result
        check("release-marker-from-store", release_marker_from_store)

        suite = ["bash", str(ROOT / "tests/integration/80_qualification_inputs.sh")]

        def cross_check_passes():
            mapped_dir = tmp / "receipts-mapped"
            mapped_dir.mkdir()
            shutil.copy(receipts / "26.4.json", mapped_dir)
            code, _, text = run(suite, dict(clean, HYPERFIDE_EVIDENCE_RECEIPTS_DIR=str(mapped_dir)), timeout=900)
            expect(code == 0 and "evidence receipts cross-checked: 1 in " + str(mapped_dir) in text and "PASS qualification inputs" in text, "80 cross-check did not pass on a mapped receipt: " + text[-1200:])
        check("cross-check-passing", cross_check_passes)

        def cross_check_unmapped():
            code, _, text = run(suite, dict(clean, HYPERFIDE_EVIDENCE_RECEIPTS_DIR=str(receipts)), timeout=900)
            expect(code == 1 and "9.9.json commit=" + mapped + " has no refs/evidence entry" in text, "80 cross-check accepted an unmapped commit: " + text[-1200:])
        check("cross-check-unmapped-commit", cross_check_unmapped)
    server.shutdown()
    print(json.dumps({"type": "cleanup", "resources": [], "complete": True}), flush=True)
    print(("FAIL: " + ", ".join(FAILED)) if FAILED else "PASS: " + str(len(IDS)) + " assertions", file=sys.stderr)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
