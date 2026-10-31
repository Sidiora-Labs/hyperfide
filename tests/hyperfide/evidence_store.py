"""Read-only s3-v1 client for task evidence bundles (decision D1).

The artifact store is the authority for qualification evidence; the local
artifacts/hyperfide/tasks/<id> directory is only a cache. A tracked receipt record
(tests/hyperfide/evidence-receipts/<id>.json, written by publishEvidenceBundle in
core/control-plane/src/artifacts/objects.ts) names the committed chunk manifest.
Resolution verifies the receipt binding, then performs the byte checks that
artifact.manifest.read and artifact.object.read perform: manifest digest and size,
canonical chunk sequence, each chunk digest and size, and the concatenated
content digest. Any integrity failure refuses; nothing partial reaches the cache.

The object key layout, receipt binding and SigV4 signing mirror objects.ts
(keyOf, receipt, S3.request); change them together.
"""
import datetime
import hashlib
import hmac
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BACKEND = "s3-v1"
RECORD_KIND = "hyperfide-evidence-receipt"
RECEIPTS_DIR = "tests/hyperfide/evidence-receipts"
TASKS_DIR = "artifacts/hyperfide/tasks"
MAX_OBJECT, MAX_MANIFEST, MAX_CHUNKS = 256 * 1024, 512 * 1024, 4096
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
TASK = re.compile(r"^[0-9]+\.[0-9]+$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
INDEX_MEMBER = "evidence-index.json"
# The release marker (deployment/releases.ts UNIT_RECEIPT) is this member of task 26.4's bundle.
UNIT_TASK = "26.4"
STORE_NAMES = ("HF_ARTIFACT_S3_ENDPOINT", "HF_ARTIFACT_S3_REGION", "HF_ARTIFACT_S3_BUCKET", "HF_ARTIFACT_S3_ACCESS_KEY_ID", "HF_ARTIFACT_S3_SECRET_ACCESS_KEY")


class EvidenceIntegrityError(Exception):
    """The store or the receipt contradicts itself. Always refuse."""


class EvidenceUnavailable(Exception):
    """No receipt or no store configuration. A warning unless the caller requires evidence."""


def _sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _require(condition, message):
    if not condition:
        raise EvidenceIntegrityError(message)


def key_of(organisation, run, value, manifest=False):
    return "hyperfide/v1/" + organisation + "/" + run + ("/manifests" if manifest else "") + "/sha256/" + value[7:]


def receipt_id(receipt):
    # JSON.stringify order of the binding in objects.ts receipt().
    binding = {name: receipt[name] for name in ("schema_version", "organisation_id", "run_id", "artifact_id", "digest", "size_bytes", "storage_backend", "storage_key", "completed_at")}
    return _sha(json.dumps(binding, separators=(",", ":"), ensure_ascii=False).encode())


def receipts_dir(root):
    override = os.environ.get("HYPERFIDE_EVIDENCE_RECEIPTS_DIR")
    return Path(override) if override else Path(root) / RECEIPTS_DIR


def load_record(root, task):
    _require(TASK.fullmatch(task) is not None, "invalid task identity: " + task)
    path = receipts_dir(root) / (task + ".json")
    if not path.is_file():
        raise EvidenceUnavailable("no artifact-store receipt for task " + task + " at " + str(path))
    try:
        record = json.loads(path.read_text())
    except ValueError as exc:
        raise EvidenceIntegrityError("unreadable receipt record " + str(path) + ": " + str(exc)) from exc
    return validate_record(record, task)


def validate_record(record, task):
    """Structural and binding checks of a receipt record; needs no store."""
    _require(isinstance(record, dict) and record.get("schema_version") == 1 and record.get("kind") == RECORD_KIND and record.get("task") == task and record.get("bundle_format") == "tar", "receipt record is not an evidence receipt for task " + task)
    receipt = record.get("receipt")
    _require(isinstance(receipt, dict), "receipt record lacks a receipt")
    fields = {"schema_version", "organisation_id", "run_id", "artifact_id", "receipt_id", "digest", "size_bytes", "storage_backend", "storage_key", "completed_at"}
    _require(set(receipt) == fields and receipt["schema_version"] == 1, "receipt fields differ from the s3-v1 receipt contract")
    _require(all(isinstance(receipt[name], str) for name in fields - {"schema_version"}), "receipt fields must be strings")
    _require(UUID.fullmatch(receipt["organisation_id"]) and UUID.fullmatch(receipt["run_id"]) and UUID.fullmatch(receipt["artifact_id"]), "receipt scope or artifact identity is not a canonical UUID")
    _require(DIGEST.fullmatch(receipt["digest"]) and DIGEST.fullmatch(receipt["receipt_id"]) and ISO.fullmatch(receipt["completed_at"]), "receipt digest or completion time is malformed")
    _require(re.fullmatch(r"0|[1-9][0-9]*", receipt["size_bytes"]) and int(receipt["size_bytes"]) <= MAX_MANIFEST, "receipt manifest size is out of bounds")
    _require(receipt["storage_backend"] == BACKEND, "receipt names an unsupported storage backend")
    _require(receipt["storage_key"] == key_of(receipt["organisation_id"], receipt["run_id"], receipt["digest"], True), "receipt storage key differs from the s3-v1 manifest layout")
    _require(receipt_id(receipt) == receipt["receipt_id"], "receipt identity differs from its binding")
    expected_org = os.environ.get("HF_ARTIFACT_ORGANISATION_ID")
    _require(not expected_org or expected_org == receipt["organisation_id"], "receipt organisation differs from HF_ARTIFACT_ORGANISATION_ID")
    _require(DIGEST.fullmatch(str(record.get("content_digest"))), "receipt record content digest is malformed")
    commits = record.get("evidence_commits")
    # Optional for records published before task 3.19; publish-evidence.py always writes it.
    _require(commits is None or (isinstance(commits, dict) and commits and set(commits) <= {"commit", "requalified_on"} and all(isinstance(v, str) and COMMIT.fullmatch(v) for v in commits.values())), "receipt record evidence commits are malformed")
    return record


def missing_store_names():
    return [name for name in STORE_NAMES if not os.environ.get(name)]


def index_commits(data):
    """The commit fields of the bundle's evidence-index.json, as publish-evidence.py records them."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        try:
            member = archive.getmember(INDEX_MEMBER)
        except KeyError:
            return {}
        index = json.loads(archive.extractfile(member).read())
    return {name: index[name] for name in ("commit", "requalified_on") if isinstance(index.get(name), str) and COMMIT.fullmatch(index[name])}


def _config():
    env = os.environ
    names = STORE_NAMES
    missing = missing_store_names()
    if missing:
        raise EvidenceUnavailable("artifact store configuration absent: " + ", ".join(missing))
    if any(re.search(r"[\x00-\x1f\x7f]", env[name]) for name in names):
        raise EvidenceUnavailable("artifact store configuration contains control characters")
    endpoint = urllib.parse.urlsplit(env["HF_ARTIFACT_S3_ENDPOINT"])
    loopback = endpoint.hostname in ("127.0.0.1", "::1")
    if endpoint.username or endpoint.password or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment:
        raise EvidenceUnavailable("HF_ARTIFACT_S3_ENDPOINT must be an origin")
    if endpoint.scheme != "https" and not (endpoint.scheme == "http" and loopback and env.get("HF_ARTIFACT_ALLOW_LOOPBACK_HTTP") == "1"):
        raise EvidenceUnavailable("HF_ARTIFACT_S3_ENDPOINT must be https (loopback http needs HF_ARTIFACT_ALLOW_LOOPBACK_HTTP=1)")
    region, bucket = env["HF_ARTIFACT_S3_REGION"], env["HF_ARTIFACT_S3_BUCKET"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", region) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) or ".." in bucket:
        raise EvidenceUnavailable("artifact store region or bucket is malformed")
    return {"origin": endpoint.scheme + "://" + endpoint.netloc, "host": endpoint.netloc, "region": region, "bucket": bucket,
            "access": env["HF_ARTIFACT_S3_ACCESS_KEY_ID"], "secret": env["HF_ARTIFACT_S3_SECRET_ACCESS_KEY"], "token": env.get("HF_ARTIFACT_S3_SESSION_TOKEN")}


def _encode(value):
    return urllib.parse.quote(value, safe="-_.~")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def signed_request(config, method, key, body=b"", extra=None):
    """A SigV4 path-style request for one object key, signed as objects.ts S3.request signs it."""
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    day = now[:8]
    pathname = "/" + _encode(config["bucket"]) + "/" + "/".join(_encode(part) for part in key.split("/"))
    payload = hashlib.sha256(body).hexdigest()
    headers = {"host": config["host"], "x-amz-content-sha256": payload, "x-amz-date": now, **(extra or {})}
    if config["token"]:
        headers["x-amz-security-token"] = config["token"]
    names = sorted(headers)
    canonical = "\n".join([method, pathname, "", "".join(name + ":" + headers[name].strip() + "\n" for name in names), ";".join(names), payload])
    scope = day + "/" + config["region"] + "/s3/aws4_request"
    to_sign = "AWS4-HMAC-SHA256\n" + now + "\n" + scope + "\n" + hashlib.sha256(canonical.encode()).hexdigest()
    signing = ("AWS4" + config["secret"]).encode()
    for part in (day, config["region"], "s3", "aws4_request"):
        signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
    headers["authorization"] = "AWS4-HMAC-SHA256 Credential=" + config["access"] + "/" + scope + ", SignedHeaders=" + ";".join(names) + ", Signature=" + hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
    return urllib.request.Request(config["origin"] + pathname, method=method, data=body if method == "PUT" else None, headers={k: v for k, v in headers.items() if k != "host"})


def _get(config, key, expected_digest, size):
    request = signed_request(config, "GET", key)
    opener = urllib.request.build_opener(_NoRedirect)
    last = None
    for _ in range(2):
        try:
            with opener.open(request, timeout=10) as response:
                length = response.headers.get("content-length")
                _require(length is None or length == str(size), "stored object length does not match its receipt: " + key)
                data = response.read(size + 1)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise EvidenceIntegrityError("receipted object is absent from the artifact store: " + key) from exc
            if exc.code == 429 or exc.code >= 500:
                last = exc
                continue
            raise EvidenceIntegrityError("artifact store rejected retrieval (HTTP " + str(exc.code) + "): " + key) from exc
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            continue
        _require(len(data) == size and _sha(data) == expected_digest, "stored object digest or length does not match its receipt: " + key)
        return data
    raise EvidenceUnavailable("artifact store unavailable: " + str(last))


def _chunks(manifest, organisation, run):
    _require(isinstance(manifest, dict) and manifest.get("schema_version") == 1 and manifest.get("kind") == "chunk-manifest", "object is not a chunk manifest")
    _require(manifest.get("organisation_id") == organisation and manifest.get("run_id") == run, "manifest scope differs from its receipt")
    _require(manifest.get("complete") is True and manifest.get("truncated") is False and manifest.get("missing_ranges") == [], "manifest is not complete")
    chunks = manifest.get("chunks")
    _require(isinstance(chunks, list) and len(chunks) == manifest.get("expected_chunks") and len(chunks) <= MAX_CHUNKS, "manifest chunk count is invalid")
    offset = 0
    for index, chunk in enumerate(chunks):
        _require(isinstance(chunk, dict) and set(chunk) == {"sequence", "artifact_id", "digest", "size_bytes", "offset_bytes"}, "manifest chunk is malformed")
        _require(chunk["sequence"] == index and chunk["offset_bytes"] == str(offset), "manifest chunks are not contiguous")
        _require(DIGEST.fullmatch(str(chunk["digest"])) and re.fullmatch(r"0|[1-9][0-9]*", str(chunk["size_bytes"])) and int(chunk["size_bytes"]) <= MAX_OBJECT, "manifest chunk identity is malformed")
        offset += int(chunk["size_bytes"])
    _require(manifest.get("total_size_bytes") == str(offset), "manifest total differs from chunk sizes")
    return chunks


def fetch_bundle(record):
    """Returns the verified bundle bytes named by a receipt record."""
    receipt, config = record["receipt"], _config()
    organisation, run = receipt["organisation_id"], receipt["run_id"]
    raw = _get(config, receipt["storage_key"], receipt["digest"], int(receipt["size_bytes"]))
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise EvidenceIntegrityError("stored manifest is not JSON") from exc
    chunks = _chunks(manifest, organisation, run)
    _require(manifest.get("content_digest") == record["content_digest"], "manifest content digest differs from the receipt record")
    parts = [_get(config, key_of(organisation, run, chunk["digest"]), chunk["digest"], int(chunk["size_bytes"])) for chunk in chunks]
    bundle = b"".join(parts)
    _require(_sha(bundle) == manifest["content_digest"], "concatenated evidence digest differs from the manifest")
    # The recorded commits are what 80_qualification_inputs.sh maps to refs/evidence; they must be the bundle's.
    _require(record.get("evidence_commits") is None or index_commits(bundle) == record["evidence_commits"], "receipt record evidence commits differ from the bundled evidence index")
    return bundle


def bundle(directory):
    """Deterministic tar of a task evidence directory: sorted members, zero times and owners."""
    directory = Path(directory)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(directory.rglob("*")):
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink() or "__pycache__" in path.parts or path.name == ".lock" or path.name.startswith(".index-"):
                continue
            info = tarfile.TarInfo(relative)
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            if path.is_dir():
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(info)
            elif path.is_file():
                data = path.read_bytes()
                info.size, info.mode = len(data), path.stat().st_mode & 0o755
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def _extract(data, target):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive.getmembers():
            name = Path(member.name)
            _require(not name.is_absolute() and ".." not in name.parts and member.name not in ("", "."), "evidence bundle member escapes its task directory: " + member.name)
            _require(member.isfile() or member.isdir(), "evidence bundle contains a non-regular member: " + member.name)
            path = target / name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open("xb") as sink:
                shutil.copyfileobj(source, sink)
            path.chmod(member.mode & 0o755)


def _cache_holds(target, data):
    """True when every member of a receipted bundle is present in the cache with the same bytes."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive.getmembers():
            path = target / member.name
            if member.isdir():
                if not path.is_dir() or path.is_symlink():
                    return False
            elif not path.is_file() or path.is_symlink() or path.read_bytes() != archive.extractfile(member).read():
                return False
    return True


def _verify_cache(root, task, target, required):
    """The local directory is a cache, never the authority (task 1.2 do_1, task 3.13).

    A cache that bundles to the receipt's content digest is verified. A cache that differs
    is accepted only when it still holds every receipted member byte for byte, which is the
    state between a local qualification run (it appends receipts) and the next publication;
    proving that needs the store. Anything else is stale or tampered and refused. With no
    receipt the cache is unverifiable: a warning, or a refusal when evidence is required.
    """
    try:
        record = load_record(root, task)
    except EvidenceUnavailable as exc:
        if required:
            raise EvidenceUnavailable("local evidence cache for task " + task + " has no receipt to verify against: " + str(exc)) from exc
        return {"status": "LOCAL_CACHE", "task": task, "verified": False, "warning": "local evidence cache is unverified: " + str(exc)}
    receipted = {"receipt_id": record["receipt"]["receipt_id"], "content_digest": record["content_digest"]}
    if _sha(bundle(target)) == record["content_digest"]:
        return {"status": "LOCAL_CACHE", "task": task, "verified": True, **receipted}
    try:
        data = fetch_bundle(record)
    except EvidenceUnavailable as exc:
        raise EvidenceIntegrityError("local evidence cache for task " + task + " differs from its receipt and the store cannot show it is only ahead (" + str(exc) + "); move the cache aside to resolve from the store") from exc
    _require(_cache_holds(target, data), "local evidence cache for task " + task + " is stale or tampered: it differs from receipted bundle " + record["content_digest"] + "; move it aside to resolve from the store")
    return {"status": "LOCAL_CACHE", "task": task, "verified": True, "ahead_of_receipt": True, "warning": "local evidence cache for task " + task + " holds the receipted bundle plus unpublished additions", **receipted}


def resolve(root, task, required=False):
    """Fills artifacts/hyperfide/tasks/<task> from the store when it is absent, and
    verifies it against the tracked receipt when it is present (_verify_cache).

    Returns a status dict. Integrity failures always raise EvidenceIntegrityError.
    A missing receipt or store configuration raises EvidenceUnavailable only when
    required (HYPERFIDE_EVIDENCE_REQUIRED=1 or the caller's flag); otherwise it is
    reported as a warning, because blocking governance is opt-in.
    """
    target = Path(root) / TASKS_DIR / task
    if target.exists():
        return _verify_cache(root, task, target, required or os.environ.get("HYPERFIDE_EVIDENCE_REQUIRED") == "1")
    try:
        record = load_record(root, task)
        data = fetch_bundle(record)
    except EvidenceUnavailable as exc:
        if required or os.environ.get("HYPERFIDE_EVIDENCE_REQUIRED") == "1":
            raise
        return {"status": "UNRESOLVED", "task": task, "warning": str(exc)}
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="." + task + ".resolve-", dir=target.parent))
    try:
        _extract(data, staging)
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {"status": "RESOLVED", "task": task, "receipt_id": record["receipt"]["receipt_id"], "manifest_digest": record["receipt"]["digest"], "content_digest": record["content_digest"]}


def read_member(root, task, member):
    """(bytes, source) of one file of a task's evidence without writing the cache.

    A present cache is verified against the receipt first (_verify_cache); with no
    cache the member comes from the receipted bundle in the store. EvidenceUnavailable
    when neither exists or the store is not configured; integrity failures raise.
    """
    target = Path(root) / TASKS_DIR / task
    if target.exists():
        status = _verify_cache(root, task, target, False)
        path = target / member
        if not path.is_file() or path.is_symlink():
            raise EvidenceUnavailable("local evidence cache for task " + task + " has no " + member)
        return path.read_bytes(), "local" if status.get("verified") else "local-unverified"
    record = load_record(root, task)
    with tarfile.open(fileobj=io.BytesIO(fetch_bundle(record)), mode="r:") as archive:
        try:
            info = archive.getmember(member)
        except KeyError as exc:
            raise EvidenceIntegrityError("receipted bundle for task " + task + " has no " + member) from exc
        _require(info.isfile(), "receipted " + member + " is not a regular member")
        return archive.extractfile(info).read(), "store"


def unit_receipt_input(root, scratch, override=None):
    """The 26.4 marker input for scripts/release.sh: (path or None, source).

    An explicit override wins; then the local cache; then the store by the tracked
    receipt, so a clean host without artifacts/ still releases. A tracked receipt the
    store cannot serve refuses rather than shipping the owning units unstartable.
    """
    if override:
        return Path(override), "override"
    try:
        data, source = read_member(root, UNIT_TASK, INDEX_MEMBER)
    except EvidenceUnavailable as exc:
        if (receipts_dir(root) / (UNIT_TASK + ".json")).is_file():
            raise EvidenceIntegrityError("task " + UNIT_TASK + " has a tracked receipt but the store cannot serve it: " + str(exc)) from exc
        return None, "absent"
    path = Path(scratch) / "unit-receipt" / INDEX_MEMBER
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path, source


def task_of_campaign(path):
    """(root, task) when path lies under <root>/artifacts/hyperfide/tasks/<task>/, else None."""
    parts = Path(path).absolute().parts
    for index in range(len(parts) - 3):
        if parts[index:index + 3] == ("artifacts", "hyperfide", "tasks") and TASK.fullmatch(parts[index + 3]):
            return Path(*parts[:index]), parts[index + 3]
    return None
