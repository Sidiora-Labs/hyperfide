#!/usr/bin/env python3
"""Inventory a pinned Git tree and a proposed category layout without moving files.

All source bytes come from the requested revision, using one cat-file process.
Worktree drift is reported separately and makes the CLI unsuccessful. The output
is a planning/evidence input, not proof that relocated runtime behavior works.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
from typing import Any, Iterator


class InventoryError(ValueError):
    """The mapping or pinned source cannot produce an unambiguous inventory."""


ACTIONS = frozenset({
    "keep", "keep-rewrite", "move", "merge", "promote", "promote-reconcile",
    "promote-rewrite", "promote-regenerate", "regenerate", "archive",
    "move-with-root-delegator",
})
DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
PACKAGE_FIELDS = (
    "name", "version", "private", "type", "exports", "bin", "main", "module",
    "types", "typings", "files", "publishConfig", "engines", "packageManager",
    "workspaces", "scripts", "dependencies", "devDependencies", "peerDependencies",
    "optionalDependencies", "peerDependenciesMeta", "bundledDependencies",
    "bundleDependencies", "overrides", "resolutions", "pnpm", "os", "cpu",
)
IDENTITY_FIELDS = (
    "name", "version", "private", "type", "exports", "bin", "main", "module",
    "types", "typings", "engines", "packageManager", "peerDependenciesMeta",
    "bundledDependencies", "bundleDependencies", "overrides", "resolutions", "os", "cpu",
)
ROOT_CONFIGS = frozenset({
    "Makefile", "CMakeLists.txt", "package.json", "pnpm-workspace.yaml", "turbo.json",
    "vitest.config.ts", "vitest.shared.ts", "vitest.global-tmpdir.ts", "tsconfig.json",
    ".nvmrc", ".node-version", ".npmrc", ".gitignore", ".gitattributes",
    ".env.example", ".oxfmtrc.json", ".oxlintrc.json", "go.mod", "go.sum",
})
PATH_REFERENCE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:platform|services|src|kvx|editors/vscode|scripts)/"
    r"[A-Za-z0-9_@.+%~*/{}$-]*(?:/[A-Za-z0-9_@.+%~*/{}$-]*)*"
)
INSTALLED_REFERENCE = re.compile(r"^services/(?:dist|components|migrations|proof|runtime)(?:/|$)")
COMMIT_LINK = re.compile(r"/(?:blob|tree)/[0-9a-f]{7,64}/")
HEX_OID = re.compile(r"^[0-9a-f]{40,64}$")


def _hash(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value.startswith("/"):
        raise InventoryError(f"{label}: expected a nonempty repository-relative path")
    if "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InventoryError(f"{label}: separators/control characters are not canonical")
    if re.match(r"^[A-Za-z]:", value) or any(part in {"", ".", "..", ".git"} for part in value.split("/")):
        raise InventoryError(f"{label}: unsafe or noncanonical path {value!r}")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError as error:
        raise InventoryError(f"{label}: invalid UTF-8 path") from error
    return value


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def _rules(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(mapping, dict) or type(mapping.get("schema_version")) is not int or mapping.get("schema_version") != 1:
        raise InventoryError("mapping requires schema_version=1")
    raw = mapping.get("mappings")
    if not isinstance(raw, list) or not raw:
        raise InventoryError("mapping requires a nonempty mappings array")
    rules, seen = [], set()
    for number, item in enumerate(raw):
        if not isinstance(item, dict):
            raise InventoryError(f"mapping rule {number}: expected an object")
        source = _path(item.get("source"), f"mapping rule {number} source")
        target = _path(item.get("destination"), f"mapping rule {number} destination")
        action = item.get("action")
        if not isinstance(action, str) or action not in ACTIONS:
            raise InventoryError(f"mapping {source}: unknown action {action!r}")
        if source in seen:
            raise InventoryError(f"duplicate mapping source {source}")
        if source in {"platform", "services"}:
            raise InventoryError(f"mapping {source}: catchall source container conceals unit classification")
        if _under(target, "platform") or _under(target, "services"):
            raise InventoryError(f"mapping {source}: destination {target} recreates a source container or installed-artifact path")
        if INSTALLED_REFERENCE.match(source):
            raise InventoryError(f"mapping {source}: installed-artifact path is not a checkout source mapping")
        if source == "services/hyperfide" and target != "core/control-plane":
            raise InventoryError("services/hyperfide checkout must map to core/control-plane; installed services/dist is separate")
        if action.startswith("keep") and source != target:
            raise InventoryError(f"mapping {source}: keep action changes its destination")
        if action == "merge" and source == target:
            raise InventoryError(f"mapping {source}: merge requires a distinct input")
        references = item.get("source_references", [])
        if not isinstance(references, list):
            raise InventoryError(f"mapping {source}: source_references must be an array")
        seen.add(source)
        rules.append(dict(item, source=source, destination=target))
    scopes = mapping.get("scope", [])
    if not isinstance(scopes, list) or any(not isinstance(x, str) for x in scopes):
        raise InventoryError("mapping scope must be an array of relative paths")
    for scope in scopes:
        _path(scope.rstrip("/"), "mapping scope")
    return sorted(rules, key=lambda rule: (-len(rule["source"]), rule["source"]))


def _map(path: str, rules: list[dict[str, Any]]) -> tuple[str, dict[str, Any] | None]:
    for rule in rules:
        if _under(path, rule["source"]):
            return rule["destination"] + path[len(rule["source"]):], rule
    return path, None


def _git(repo: Path, *arguments: str) -> bytes:
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    result = subprocess.run(["git", "-C", str(repo), *arguments], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=environment, check=False)
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise InventoryError(f"git {' '.join(arguments[:2])}: {message}")
    return result.stdout


def _tracked(repo: Path, revision: str) -> list[dict[str, Any]]:
    result = []
    for record in _git(repo, "ls-tree", "-r", "-z", "--full-tree", "-l", revision).split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, kind, oid, size = metadata.decode("ascii").split()
            path = _path(raw_path.decode("utf-8", "strict"), "tracked path")
        except (UnicodeError, ValueError) as error:
            raise InventoryError("unsupported tracked Git tree entry") from error
        result.append({"source": path, "mode": mode, "object_type": kind,
                       "object_id": oid, "blob_id": oid if kind == "blob" else None,
                       "size": None if size == "-" else int(size)})
    return sorted(result, key=lambda item: item["source"])


def _blob_stream(repo: Path, object_ids: list[str]) -> Iterator[tuple[str, bytes]]:
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    with subprocess.Popen(["git", "-C", str(repo), "cat-file", "--batch"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env=environment) as process:
        assert process.stdin is not None and process.stdout is not None
        try:
            for oid in object_ids:
                process.stdin.write(oid.encode("ascii") + b"\n")
                process.stdin.flush()
                header = process.stdout.readline().split()
                if len(header) != 3 or header[1] != b"blob":
                    raise InventoryError(f"pinned Git blob unavailable: {oid}")
                length = int(header[2])
                parts, remaining = [], length
                while remaining:
                    part = process.stdout.read(remaining)
                    if not part:
                        raise InventoryError(f"truncated Git blob: {oid}")
                    parts.append(part)
                    remaining -= len(part)
                if process.stdout.read(1) != b"\n":
                    raise InventoryError(f"invalid cat-file frame: {oid}")
                yield oid, b"".join(parts)
        finally:
            process.stdin.close()
            if process.poll() is None:
                process.terminate()
            process.wait()


def _collisions(files: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    targets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    folded: dict[str, str] = {}
    for entry in files:
        target = entry["target"]
        previous = folded.get(target.casefold())
        if previous is not None and previous != target:
            raise InventoryError(f"casefold destination collision: {previous} and {target}")
        folded[target.casefold()] = target
        targets[target].append(entry)
    for target, inputs in targets.items():
        if len(inputs) > 1:
            explicit = any(item["action"] == "merge" for item in inputs)
            compatible = all(item["action"] == "merge" or
                             (item["source"] == target and item["action"] == "keep") for item in inputs)
            if not explicit or not compatible:
                names = ", ".join(item["source"] for item in inputs)
                raise InventoryError(f"duplicate destination {target}: {names}; explicit merge required for each incoming input")
    # A file cannot also be the parent directory of another output.
    for target in targets:
        parent = PurePosixPath(target).parent
        while str(parent) != ".":
            if str(parent).casefold() in folded:
                conflicting = folded[str(parent).casefold()]
                raise InventoryError(f"file/directory destination collision (including casefold): {conflicting} and {target}")
            parent = parent.parent
    return targets


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise InventoryError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _json(data: bytes, path: str) -> dict[str, Any]:
    try:
        value = json.loads(data, object_pairs_hook=_unique_pairs)
    except (ValueError, UnicodeError) as error:
        raise InventoryError(f"invalid JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise InventoryError(f"{path}: expected a JSON object")
    return value


def _lockfile(entry: dict[str, Any], data: bytes, rules: list[dict[str, Any]]) -> dict[str, Any]:
    source = entry["source"]
    value = {key: entry[key] for key in ("source", "target", "blob_id", "size")}
    value["sha256"] = _hash(data)
    if source.endswith("package-lock.json"):
        parsed = _json(data, source)
        packages = parsed.get("packages", {})
        value.update(format="npm", lockfile_version=parsed.get("lockfileVersion"),
                     name=parsed.get("name"), version=parsed.get("version"),
                     importers=sorted(packages) if isinstance(packages, dict) else [])
        # Source locations in package-lock remain local to its independent manager.
        graph = {"packages": packages, "dependencies": parsed.get("dependencies", {})}
        value["resolution_identity"] = _hash(_canonical_json(graph))
        value["resolution_records"] = graph
    elif source.endswith("pnpm-lock.yaml"):
        text = data.decode("utf-8", "strict")
        match = re.search(r"(?m)^lockfileVersion:\s*['\"]?([^'\"\s]+)", text)
        importers, resolution_lines = [], []
        section = ""
        for line in text.splitlines():
            top = re.match(r"^([A-Za-z][A-Za-z0-9]*):(?:\s.*)?$", line)
            if top:
                section = top.group(1)
            if section == "importers":
                importer = re.match(r"^  ([^ ].*):\s*$", line)
                if importer:
                    relative = importer.group(1).strip("'\"")
                    original = posixpath.normpath(posixpath.join(posixpath.dirname(source), relative))
                    mapped, _ = _map(original, rules)
                    importers.append({"path": relative, "source_root": original, "target_root": mapped})
            if section in {"packages", "snapshots"}:
                resolution_lines.append(line)
        resolution = "\n".join(resolution_lines)
        value.update(format="pnpm", lockfile_version=match.group(1) if match else None,
                     importers=importers, resolution_identity=_hash(resolution.encode("utf-8")),
                     resolution_records=resolution)
    else:
        value.update(format="other", importers=[], resolution_identity=_hash(data))
    return value


def _config_kind(path: str) -> str | None:
    name = PurePosixPath(path).name
    if name == "pnpm-workspace.yaml":
        return "workspace-membership"
    if name in {"Makefile", "CMakeLists.txt", "go.mod", "go.sum"}:
        return "native-build"
    if name in {".nvmrc", ".node-version", ".npmrc"}:
        return "toolchain-pin"
    if name.startswith(("vitest.", "turbo.", "tsconfig", ".oxlint", ".oxfmt")):
        return "workspace-test-config"
    if path.startswith(".github/workflows/"):
        return "ci-workflow"
    if name == ".hyperfide-env-setup.sh":
        return "environment-hook"
    return None


def _historical(path: str, line: str) -> bool:
    return (path.startswith(("docs/history/", "artifacts/")) or
            (path.startswith("spec/") and not path.startswith("spec/hyperfide-source-control/")) or
            PurePosixPath(path).name == "CHANGELOG.md" or
            bool(COMMIT_LINK.search(line)) or
            ("/fixtures/" in path and any(x in path.lower() for x in ("transcript", "receipt", "history"))))


def _references(entry: dict[str, Any], text: str, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        for match in PATH_REFERENCE.finditer(line):
            reference = match.group().rstrip("/")
            target, rule = _map(reference, rules)
            if _historical(entry["source"], line):
                classification = "historical"
            elif INSTALLED_REFERENCE.match(reference):
                classification = "installed-artifact"
            elif rule is not None and rule["source"] != rule["destination"]:
                classification = "source"
            else:
                classification = "unresolved"
            found.append({"consumer": entry["source"], "consumer_target": entry["target"],
                          "line": number, "column": match.start() + 1,
                          "reference": reference, "classification": classification,
                          "kind": classification, "rule_source": rule["source"] if rule else None,
                          "mapped_reference": target if classification == "source" else None,
                          "rewrite": classification == "source", "review_required": classification == "unresolved",
                          "context": line.strip()[:300]})
    return found


def _is_runtime(path: str, mapping: dict[str, Any], rules: list[dict[str, Any]]) -> bool:
    if any(_under(path, scope.rstrip("/")) for scope in mapping.get("scope", [])):
        return True
    if PurePosixPath(path).name in ROOT_CONFIGS and "/" not in path:
        return True
    return any(_under(path, rule["source"]) and rule["action"] not in {"keep", "archive"} for rule in rules)


def _drift(repo: Path, revision: str, mapping: dict[str, Any], rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = _git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                   "--name-status", "-z", revision, "--").split(b"\0")
    drift = []
    for index in range(0, len(records) - 1, 2):
        status = records[index].decode("ascii", "replace")
        path = records[index + 1].decode("utf-8", "strict")
        if _is_runtime(path, mapping, rules):
            drift.append({"source": path, "status": status, "tracked": True})
    for raw_path in _git(repo, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
        if raw_path:
            path = raw_path.decode("utf-8", "strict")
            if _is_runtime(path, mapping, rules):
                drift.append({"source": path, "status": "UNTRACKED", "tracked": False})
    return sorted(drift, key=lambda row: (row["source"], row["status"]))


def _dependency_identities(packages: list[dict[str, Any]], rules: list[dict[str, Any]]) -> None:
    by_directory = {posixpath.dirname(row["source"]): row.get("name") for row in packages}
    for package in packages:
        identities = {}
        for field in DEPENDENCY_FIELDS:
            normalized = {}
            dependencies = package.get(field, {})
            if not isinstance(dependencies, dict):
                raise InventoryError(f"{package['source']}: {field} must be an object")
            for name, version in dependencies.items():
                if not isinstance(version, str):
                    raise InventoryError(f"{package['source']}: non-string dependency {name}")
                match = re.match(r"^(file|link|workspace):((?:\.\.?/).*)$", version)
                if match:
                    source = posixpath.normpath(posixpath.join(posixpath.dirname(package["source"]), match.group(2)))
                    target, _ = _map(source, rules)
                    normalized[name] = {"protocol": match.group(1), "package": by_directory.get(source), "target": target}
                else:
                    normalized[name] = version
            identities[field] = normalized
        package["dependency_identities"] = identities


def generate_inventory(repo: Path, mapping: dict, revision: str = "HEAD") -> dict:
    """Return a complete pinned inventory; malformed plans raise InventoryError.

    Runtime worktree drift is returned in ``worktree_drift`` and sets ``valid``
    false. It never changes the pinned bytes used to construct this report.
    """
    repo = Path(repo).resolve()
    rules = _rules(mapping)
    resolved = _git(repo, "rev-parse", "--verify", "--end-of-options", revision + "^{commit}").decode("ascii").strip()
    if not HEX_OID.fullmatch(resolved):
        raise InventoryError("revision did not resolve to a Git commit")
    files = _tracked(repo, resolved)
    for entry in files:
        target, rule = _map(entry["source"], rules)
        if rule is None and entry["source"].startswith(("platform/", "services/")):
            raise InventoryError(f"uncovered tracked input: {entry['source']}")
        entry.update(target=target, action=rule["action"] if rule else "keep",
                     rule_source=rule["source"] if rule else None)
    targets = _collisions(files)
    by_blob: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in files:
        if entry["object_type"] == "blob":
            by_blob[entry["object_id"]].append(entry)
    packages, locks, configs, fragments, obligations = [], [], [], [], []
    for oid, data in _blob_stream(repo, sorted(by_blob)):
        for entry in by_blob[oid]:
            source = entry["source"]
            entry["sha256"] = _hash(data)
            if source.endswith("/package.json") or source == "package.json":
                parsed = _json(data, source)
                package = {key: entry[key] for key in ("source", "target", "blob_id", "mode", "size")}
                package.update({key: parsed[key] for key in PACKAGE_FIELDS if key in parsed})
                package["manifest"] = parsed
                packages.append(package)
            if PurePosixPath(source).name in {"pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"}:
                locks.append(_lockfile(entry, data, rules))
            kind = _config_kind(source)
            if kind:
                config = {key: entry[key] for key in ("source", "target", "blob_id", "mode", "size", "sha256")}
                config.update(kind=kind, content=data.decode("utf-8", "replace"))
                configs.append(config)
            if source.endswith(".kvx") and (source.startswith("src/") or "/components/" in source):
                fragment = {key: entry[key] for key in ("source", "target", "blob_id", "mode", "size", "sha256")}
                fragment["content"] = data.decode("utf-8", "replace")
                fragments.append(fragment)
            # Binary blobs and symlink targets do not contain executable text references.
            if entry["mode"] != "120000" and b"\0" not in data:
                try:
                    text = data.decode("utf-8", "strict")
                except UnicodeError:
                    continue
                obligations.extend(_references(entry, text, rules))
    _dependency_identities(packages, rules)
    inverse = []
    for target, inputs in sorted(targets.items()):
        inverse.append({"target": target, "automatic": len(inputs) == 1 and inputs[0]["action"] not in {"merge", "regenerate", "promote-regenerate", "promote-reconcile"},
                        "inputs": [{key: item[key] for key in ("source", "mode", "object_type", "object_id", "blob_id", "size", "action")} for item in inputs],
                        "requires_original_inputs": len(inputs) > 1 or any(item["action"] == "merge" for item in inputs)})
    per_rule: dict[str, list[int]] = defaultdict(list)
    for index, obligation in enumerate(obligations):
        if obligation["rule_source"] is not None:
            per_rule[obligation["rule_source"]].append(index)
    drift = _drift(repo, resolved, mapping, rules)
    return {
        "schema_version": 1, "revision": resolved, "requested_revision": revision,
        "source_baseline": mapping.get("source_baseline"), "mapping_digest": _hash(_canonical_json(mapping)),
        "valid": not drift, "errors": [f"runtime worktree drift: {item['source']} ({item['status']})" for item in drift],
        "files": files, "inverse_plan": inverse,
        "packages": sorted(packages, key=lambda item: item["source"]),
        "lockfiles": sorted(locks, key=lambda item: item["source"]),
        "configs": sorted(configs, key=lambda item: item["source"]),
        "native_fragments": sorted(fragments, key=lambda item: item["source"]),
        "rewrite_obligations": obligations,
        "mapping_rules": [dict(rule, source_references=per_rule[rule["source"]]) for rule in sorted(rules, key=lambda item: item["source"])],
        "worktree_drift": drift,
        "summary": {"tracked_files": len(files), "packages": len(packages), "lockfiles": len(locks),
                    "merged_targets": sum(len(items) > 1 for items in targets.values()),
                    "reference_classifications": dict(sorted(Counter(row["classification"] for row in obligations).items()))},
        "baseline_checks": {"status": "UNRUN", "results": [], "reason": "Inventory does not execute runtime builds or tests."},
    }


def compare_inventories(before: dict, after: dict) -> list[str]:
    """Compare a proposed input inventory with a resulting pinned inventory.

    Every changed blob requires an explicit rewrite disposition, including
    path-sensitive source/configuration and merged inputs. Original identities
    remain in the inverse plan; package and installed-artifact contracts are
    checked independently. This comparator does not approve source rewrites.
    """
    errors = []
    for name, inventory in (("before", before), ("after", after)):
        if not isinstance(inventory, dict) or inventory.get("schema_version") != 1:
            return [f"{name}: unsupported inventory schema"]
        if inventory.get("worktree_drift"):
            errors.append(f"{name}: runtime worktree drift remains")
    after_files = {entry["source"]: entry for entry in after.get("files", [])}
    if len(after_files) != len(after.get("files", [])):
        errors.append("after: duplicate file inventory sources")
    for entry in before.get("files", []):
        actual = after_files.get(entry["target"])
        if actual is None:
            errors.append(f"missing mapped file: {entry['source']} -> {entry['target']}")
            continue
        if entry.get("mode") != actual.get("mode"):
            errors.append(f"file mode changed: {entry['source']}")
        original_id = entry.get("object_id", entry.get("blob_id"))
        resulting_id = actual.get("object_id", actual.get("blob_id"))
        if original_id != resulting_id:
            errors.append(f"content rewrite requires explicit disposition: {entry['source']} -> {entry['target']} ({original_id} -> {resulting_id})")
    after_packages = {item["source"]: item for item in after.get("packages", [])}
    for package in before.get("packages", []):
        actual = after_packages.get(package["target"])
        if actual is None:
            errors.append(f"missing mapped package: {package['source']} -> {package['target']}")
            continue
        for field in IDENTITY_FIELDS:
            if package.get(field) != actual.get(field):
                errors.append(f"package identity changed: {package['source']} field {field}")
        # Compare raw dependencies too, except location protocols resolved below.
        for field in DEPENDENCY_FIELDS:
            expected = package.get("dependency_identities", {}).get(field, package.get(field, {}))
            observed = actual.get("dependency_identities", {}).get(field, actual.get(field, {}))
            if expected != observed:
                errors.append(f"package dependency changed: {package['source']} field {field}")
            if set(package.get(field, {})) != set(actual.get(field, {})):
                errors.append(f"package dependency membership changed: {package['source']} field {field}")
            for dependency, value in package.get(field, {}).items():
                if not isinstance(value, str) or re.match(r"^(?:file|link|workspace):\.\.?/", value):
                    continue
                if actual.get(field, {}).get(dependency) != value:
                    errors.append(f"package dependency changed: {package['source']} {dependency}")
    after_locks = {item["source"]: item for item in after.get("lockfiles", [])}
    for lock in before.get("lockfiles", []):
        actual = after_locks.get(lock["target"])
        if actual is None:
            errors.append(f"missing mapped lockfile: {lock['source']}")
        elif lock.get("resolution_identity") != actual.get("resolution_identity"):
            errors.append(f"dependency resolution changed: {lock['source']}")
    after_artifacts = Counter((item["consumer"], item["reference"]) for item in after.get("rewrite_obligations", []) if item.get("classification") == "installed-artifact")
    needed_artifacts = Counter((item["consumer_target"], item["reference"]) for item in before.get("rewrite_obligations", []) if item.get("classification") == "installed-artifact")
    for key, count in needed_artifacts.items():
        if after_artifacts[key] < count:
            errors.append(f"installed-artifact reference changed or reclassified: {key[0]}:{key[1]}")
    return sorted(set(errors))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    arguments = parser.parse_args(argv)
    try:
        with arguments.mapping.open("r", encoding="utf-8") as stream:
            mapping = json.load(stream, object_pairs_hook=_unique_pairs)
        report = generate_inventory(arguments.repo, mapping, arguments.revision)
    except (InventoryError, OSError, ValueError) as error:
        report = {"schema_version": 1, "valid": False, "errors": [str(error)]}
    output = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if arguments.output:
        try:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(output, encoding="utf-8")
        except OSError as error:
            print(f"layout inventory: cannot write output: {error}", file=sys.stderr)
            return 1
    else:
        sys.stdout.write(output)
    if not report.get("valid"):
        for message in report.get("errors", []):
            print(f"layout inventory: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
