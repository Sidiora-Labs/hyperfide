#!/usr/bin/env python3
"""Evidence through the S3 artifact store (task 1.2, decision D1).

A loopback stub speaks the s3-v1 object contract that core/control-plane/src/artifacts/objects.ts
uses (path-style bucket/key, SigV4 with a test-only key, If-None-Match PUT, 404 for absence) and
verifies every signature. No real bucket or credential is involved.

The bundle is published by the real publishEvidenceBundle compiled from objects.ts. Only the
PostgreSQL metadata half of the artifact store is replaced, by an in-memory registry that
returns the same envelopes and receipt binding; the object bytes it reports are stored in the
stub. Resolution then runs through the real qualify.py and check-evidence.py on a scratch root
with a registered one-assertion variant."""
import base64, hashlib, hmac, http.server, json, os, pathlib, shutil, subprocess, sys, tempfile, threading

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "core/control-plane"
QUALIFY, CHECKER = ROOT / "tests/hyperfide/qualify.py", ROOT / "tests/hyperfide/check-evidence.py"
TASK, ORG, RUN = "9.1", "7d0f9a52-6c0e-4b8e-9a51-3f1c2d4e5a60", "1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8"
ACCESS, SECRET, REGION, BUCKET = "AKIASTUBONLY", "stub-secret-not-a-credential", "stub-region-1", "stub-evidence"
IDS, FAILED = [], []


def expect(value, message="assertion failed"):
    if not value:
        raise AssertionError(message)


def check(name, fn):
    identity = "evidence.store." + name
    IDS.append(identity)
    try:
        actual = fn() or "observed"
    except Exception as error:  # every failure is reported, none is swallowed
        actual = type(error).__name__ + ": " + str(error)
        FAILED.append(identity)
    print(json.dumps({"type": "assertion", "id": identity, "expected": "observed", "actual": actual}), flush=True)


class Stub(http.server.BaseHTTPRequestHandler):
    objects, gets, secret = {}, [], SECRET

    def log_message(self, *args):
        pass

    def _authorised(self, body):
        auth = self.headers.get("authorization", "")
        try:
            credential = auth.split("Credential=")[1].split(",")[0]
            signed = auth.split("SignedHeaders=")[1].split(",")[0].split(";")
            signature = auth.split("Signature=")[1]
        except IndexError:
            return False
        access, day, region, service, terminal = credential.split("/")
        if access != ACCESS or region != REGION or service != "s3" or terminal != "aws4_request":
            return False
        payload = hashlib.sha256(body).hexdigest()
        if self.headers.get("x-amz-content-sha256") != payload or "host" not in signed:
            return False
        canonical_headers = "".join(name + ":" + self.headers.get(name, "").strip() + "\n" for name in signed)
        canonical = "\n".join([self.command, self.path, "", canonical_headers, ";".join(signed), payload])
        to_sign = "AWS4-HMAC-SHA256\n" + self.headers["x-amz-date"] + "\n" + day + "/" + region + "/s3/aws4_request\n" + hashlib.sha256(canonical.encode()).hexdigest()
        key = ("AWS4" + Stub.secret).encode()
        for part in (day, region, "s3", "aws4_request"):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        return hmac.compare_digest(hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest(), signature)

    def _reply(self, status, body=b"", etag=None):
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        if etag:
            self.send_header("etag", etag)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorised(b""):
            return self._reply(403)
        Stub.gets.append(self.path)
        data = Stub.objects.get(self.path)
        if data is None:
            return self._reply(404)
        self._reply(200, data, '"' + hashlib.md5(data).hexdigest() + '"')

    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if not self._authorised(body):
            return self._reply(403)
        if self.headers.get("if-none-match") == "*" and self.path in Stub.objects:
            return self._reply(412)
        Stub.objects[self.path] = body
        self._reply(200)


# The metadata half of ArtifactStore (PostgreSQL) as an in-memory registry. It returns the
# envelopes ArtifactStore.invoke returns and the receipt binding of objects.ts receipt().
DOUBLE = r"""
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const {publishEvidenceBundle}=await import(process.argv[2]);
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const key=(s,d,m)=>'hyperfide/v1/'+s.organisation_id+'/'+s.run_id+(m?'/manifests':'')+'/sha256/'+d.slice(7);
const rows=new Map(),objects={},calls=[];
function row(scope,bytes,manifest,input){
 const digest=sha(bytes),r={organisation_id:scope.organisation_id,run_id:scope.run_id,id:randomUUID(),digest,size_bytes:String(bytes.length),storage_backend:'s3-v1',storage_key:key(scope,digest,manifest),completed_at:new Date().toISOString(),retention_class:input.retention_class};
 rows.set(r.id,r);objects[r.storage_key]=bytes.toString('base64');return r;
}
function receipt(r){const b={schema_version:1,organisation_id:r.organisation_id,run_id:r.run_id,artifact_id:r.id,digest:r.digest,size_bytes:r.size_bytes,storage_backend:r.storage_backend,storage_key:r.storage_key,completed_at:r.completed_at};return {...b,receipt_id:sha(JSON.stringify(b))};}
const env=(r,extra={})=>({outcome:'SUCCEEDED',availability:'VERIFIED',artifact:{artifact_id:r.id,retention_class:r.retention_class},receipt:receipt(r),authority:'NONE',live_qualification:'NOT_EVALUATED',...extra});
const store={async invoke(action,input){
 calls.push({action,retention_class:input.retention_class??null});
 const scope={organisation_id:input.organisation_id,run_id:input.run_id};
 if(action==='artifact.object.put'){const b=Buffer.from(input.data_base64,'base64');if(sha(b)!==input.digest)throw new Error('digest');return env(row(scope,b,false,input));}
 if(action==='artifact.manifest.commit'){
  const m={schema_version:1,kind:'chunk-manifest',...scope,expected_chunks:input.expected_chunks,total_size_bytes:input.total_size_bytes,content_digest:input.content_digest,complete:true,truncated:false,missing_ranges:[],chunks:input.chunks.map(c=>({sequence:c.sequence,artifact_id:c.artifact_id,digest:c.digest,size_bytes:c.size_bytes,offset_bytes:c.offset_bytes}))};
  const r=row(scope,Buffer.from(JSON.stringify(m)),true,input);r.manifest=m;return env(r,{manifest_digest:r.digest,content_digest:m.content_digest,chunk_count:m.chunks.length});
 }
 if(action==='artifact.manifest.read'){const r=rows.get(input.artifact_id);return env(r,{manifest:r.manifest,manifest_digest:r.digest,content_digest:r.manifest.content_digest,chunk_count:r.manifest.chunks.length});}
 throw new Error('unexpected action '+action);
}};
const record=await publishEvidenceBundle(store,{},{organisation_id:process.argv[4],run_id:process.argv[5]},process.argv[6],readFileSync(process.argv[3]));
writeFileSync(process.argv[7],JSON.stringify({record,objects,calls}));
"""


def build_root(base):
    tests = base / "tests/hyperfide"
    (tests / "registrations").mkdir(parents=True)
    (base / "src").mkdir()
    probe = base / "src/probe.py"
    probe.write_text("import json\nprint(json.dumps({'type':'assertion','id':'probe.ok','expected':1,'actual':1}))\nprint(json.dumps({'type':'cleanup','resources':[],'complete':True}))\n")
    (tests / "registry.json").write_text(json.dumps({"schema_version": 1, "cases": {"V-001": {"full_assertion_ids": []}}, "suites": {}}))
    (tests / "registrations/probe.json").write_text(json.dumps({"schema_version": 1, "variant": "v21-1-2-probe", "task": TASK, "scope": "task-component", "cases": ["V-001"], "assertion_ids": ["probe.ok"], "argv": [sys.executable, "src/probe.py"], "source_files": ["src/probe.py"], "source_roots": ["src"]}))
    data = probe.read_bytes()
    manifest = tests / "manifest.json"
    manifest.write_text(json.dumps({"schema_version": 1, "campaign_id": "v21-1-2", "registered_variant": "v21-1-2-probe", "scope": "task-component", "case_ids": ["V-001"], "expected_assertion_ids": ["probe.ok"], "approval": {"approved": True, "allowed_actions": []}, "inputs": [{"path": "src/probe.py", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}], "resources": [], "seed": 1, "policy": {}}))
    return manifest


def run(argv, env, cwd):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
    lines = result.stdout.strip().splitlines()
    return result.returncode, (json.loads(lines[-1]) if lines else {}), result.stderr


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="hf-v21-1-2-") as tmp:
        tmp = pathlib.Path(tmp)
        base = tmp / "root"
        manifest = build_root(base)
        task_dir = base / "artifacts/hyperfide/tasks" / TASK
        record_path = base / "tests/hyperfide/evidence-receipts" / (TASK + ".json")
        env = {key: value for key, value in os.environ.items() if not key.startswith(("HF_ARTIFACT_", "HYPERFIDE_EVIDENCE_"))}
        env.update({"HF_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:" + str(server.server_address[1]), "HF_ARTIFACT_ALLOW_LOOPBACK_HTTP": "1", "HF_ARTIFACT_S3_REGION": REGION, "HF_ARTIFACT_S3_BUCKET": BUCKET, "HF_ARTIFACT_S3_ACCESS_KEY_ID": ACCESS, "HF_ARTIFACT_S3_SECRET_ACCESS_KEY": SECRET})
        qualify = [sys.executable, str(QUALIFY), "--root", str(base), "--task", TASK, "--manifest", str(manifest)]
        state = {}

        def first_run_warns_on_missing_receipt():
            code, out, err = run(qualify, env, base)
            expect(code == 0 and out["status"] == "PASS", "first qualification did not pass: " + json.dumps(out) + err[-500:])
            expect(out["evidence_source"]["status"] == "UNRESOLVED" and "no artifact-store receipt" in out["evidence_source"]["warning"], "missing receipt was not reported: " + json.dumps(out))
            expect("warning: no artifact-store receipt" in err, "missing receipt warning not on stderr")
            state["campaign"] = pathlib.Path(out["campaign_dir"])
        check("missing-receipt-warns", first_run_warns_on_missing_receipt)

        def missing_receipt_blocks_when_required():
            shutil.move(str(task_dir), str(tmp / "kept"))
            try:
                code, out, _ = run(qualify + ["--require-evidence"], env, base)
                expect(code == 2 and out["status"] == "BLOCKED" and "no artifact-store receipt" in out["diagnostics"][0], "required evidence did not block: " + json.dumps(out))
                code, out, _ = run([sys.executable, str(CHECKER), "--campaign", str(state["campaign"])], env, base)
                expect(code == 1 and "no artifact-store receipt" in out["error"], "checker did not refuse a missing receipt: " + json.dumps(out))
                expect(not task_dir.exists(), "refusal left a partial cache")
            finally:
                shutil.move(str(tmp / "kept"), str(task_dir))
        check("missing-receipt-blocks-when-required", missing_receipt_blocks_when_required)

        def publish_through_typescript():
            bundle = tmp / "bundle.tar"
            code, out, err = run([sys.executable, str(QUALIFY), "--root", str(base), "--bundle-evidence", TASK, "--bundle-output", str(bundle)], env, base)
            expect(code == 0 and out["status"] == "BUNDLED", "bundle failed: " + json.dumps(out) + err)
            expect(out["content_digest"] == "sha256:" + hashlib.sha256(bundle.read_bytes()).hexdigest(), "bundle digest mismatch")
            expect(out["size_bytes"] > 256 * 1024, "ballast did not push the bundle past one s3-v1 object")
            compiled = tmp / "ts"
            r = subprocess.run([str(SERVICE / "node_modules/.bin/tsc"), "--ignoreConfig", "--outDir", str(compiled / "dist"), "--rootDir", str(SERVICE / "src"), "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--types", "node", "--strict", "--skipLibCheck", str(SERVICE / "src/artifacts/objects.ts")], cwd=SERVICE, capture_output=True, text=True, timeout=300)
            expect(r.returncode == 0, "objects.ts did not compile: " + r.stdout[-1500:] + r.stderr[-500:])
            (compiled / "package.json").write_text('{"type":"module"}')
            (compiled / "node_modules").symlink_to(SERVICE / "node_modules", target_is_directory=True)
            (compiled / "double.mjs").write_text(DOUBLE)
            result = tmp / "published.json"
            r = subprocess.run(["node", str(compiled / "double.mjs"), (compiled / "dist/artifacts/objects.js").as_uri(), str(bundle), ORG, RUN, TASK, str(result)], capture_output=True, text=True, timeout=120)
            expect(r.returncode == 0, "publishEvidenceBundle failed: " + r.stderr[-1500:])
            published = json.loads(result.read_text())
            record = published["record"]
            actions = [call["action"] for call in published["calls"]]
            expect(actions[-2:] == ["artifact.manifest.commit", "artifact.manifest.read"] and set(actions[:-2]) == {"artifact.object.put"}, "unexpected publication sequence: " + str(actions))
            expect(all(call["retention_class"] == "RELEASE" for call in published["calls"] if call["action"] != "artifact.manifest.read"), "evidence not published under RELEASE retention")
            expect(record["chunk_count"] == len(actions) - 2 and record["chunk_count"] >= 2, "bundle was not chunked: " + str(record["chunk_count"]))
            for key, value in published["objects"].items():
                Stub.objects["/" + BUCKET + "/" + key] = base64.b64decode(value)
            record_path.parent.mkdir(parents=True)
            record_path.write_text(json.dumps(record, indent=2) + "\n")
            state["record"] = record
            return "published " + str(record["chunk_count"]) + " chunks"
        # Ballast inside the task directory so publication spans several s3-v1 objects.
        (task_dir / "ballast.bin").write_bytes(hashlib.sha256(b"seed").digest() * 20000)
        check("publish-via-manifest-commit", publish_through_typescript)

        def checker_resolves_absent_local():
            shutil.rmtree(task_dir)
            Stub.gets.clear()
            code, out, err = run([sys.executable, str(CHECKER), "--campaign", str(state["campaign"])], env, base)
            expect(code == 0 and out["checked"] is True, "checker did not verify resolved evidence: " + json.dumps(out) + err[-500:])
            expect((task_dir / "ballast.bin").is_file() and state["campaign"].is_dir(), "cache was not restored")
            expect(len(Stub.gets) == 1 + state["record"]["chunk_count"], "expected one signed GET per manifest and chunk, saw " + str(len(Stub.gets)))
        check("absent-local-resolves-for-checker", checker_resolves_absent_local)

        def qualify_resolves_and_chains():
            shutil.rmtree(task_dir)
            code, out, err = run(qualify, env, base)
            expect(code == 0 and out["status"] == "PASS", "requalification failed: " + json.dumps(out) + err[-500:])
            source = out["evidence_source"]
            expect(source["status"] == "RESOLVED" and source["receipt_id"] == state["record"]["receipt"]["receipt_id"], "qualify did not resolve by receipt: " + json.dumps(source))
            receipts = sorted(json.loads(path.read_text())["sequence"] for path in (pathlib.Path(out["campaign_dir"]) / "receipts").glob("*.json"))
            expect(pathlib.Path(out["campaign_dir"]) == state["campaign"] and receipts == [1, 2], "restored receipt chain was not continued: " + str(receipts))
        check("absent-local-resolves-for-qualify", qualify_resolves_and_chains)

        def refused(mutate, restore, needle):
            shutil.rmtree(task_dir, ignore_errors=True)
            mutate()
            try:
                code, out, _ = run(qualify, env, base)
                expect(code == 2 and out["status"] == "BLOCKED" and needle in out["diagnostics"][0], "qualify did not refuse: " + json.dumps(out))
                code, out, _ = run([sys.executable, str(CHECKER), "--campaign", str(state["campaign"])], env, base)
                expect(code == 1 and needle in out["error"], "checker did not refuse: " + json.dumps(out))
                expect(not task_dir.exists() and not list(task_dir.parent.glob(".*resolve-*")), "refusal left a partial cache")
            finally:
                restore()
            return "refused: " + needle

        chunk_key = "/" + BUCKET + "/hyperfide/v1/" + ORG + "/" + RUN + "/sha256/"
        def tamper_chunk():
            path = next(key for key in Stub.objects if key.startswith(chunk_key))
            original = Stub.objects[path]
            def mutate():
                Stub.objects[path] = bytes([original[0] ^ 1]) + original[1:]
            def restore():
                Stub.objects[path] = original
            return refused(mutate, restore, "digest or length does not match")
        check("digest-mismatch-refused", tamper_chunk)

        def forged_receipt():
            original = record_path.read_text()
            def mutate():
                record = json.loads(original)
                record["receipt"]["completed_at"] = "2020-01-01T00:00:00.000Z"
                record_path.write_text(json.dumps(record))
            return refused(mutate, lambda: record_path.write_text(original), "receipt identity differs from its binding")
        check("forged-receipt-refused", forged_receipt)

        def absent_object():
            manifest_key = "/" + BUCKET + "/" + state["record"]["receipt"]["storage_key"]
            original = Stub.objects[manifest_key]
            return refused(lambda: Stub.objects.pop(manifest_key), lambda: Stub.objects.__setitem__(manifest_key, original), "absent from the artifact store")
        check("absent-object-refused", absent_object)

        def wrong_credentials():
            def mutate():
                Stub.secret = "rotated"
            def restore():
                Stub.secret = SECRET
            return refused(mutate, restore, "HTTP 403")
        check("rejected-signature-refused", wrong_credentials)

        def restored_after_negatives():
            shutil.rmtree(task_dir, ignore_errors=True)
            code, out, _ = run([sys.executable, str(CHECKER), "--campaign", str(state["campaign"])], env, base)
            expect(code == 0 and out["checked"] is True, "store no longer resolves after negatives: " + json.dumps(out))
        check("positive-after-negatives", restored_after_negatives)
    server.shutdown()
    print(json.dumps({"type": "cleanup", "resources": [], "complete": True}), flush=True)
    print(("FAIL: " + ", ".join(FAILED)) if FAILED else "PASS: " + str(len(IDS)) + " assertions", file=sys.stderr)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
