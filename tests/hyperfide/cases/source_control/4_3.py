#!/usr/bin/env python3
"""Exercise product source actions against the real native service."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location(
    "native_source_fixture", ROOT / "tests/hyperfide/support/native_source_fixture.py"
)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def source_product_evidence():
    output = ROOT / "build/source-control/product"
    receipt = json.loads((output / "receipt.json").read_text())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    assert receipt["status"] == "PASS"
    assert receipt["revision"] == revision, "Product evidence must bind the verified revision"
    assert receipt["backend_requests"] > 0
    for criterion in (
        "incomplete dependency closure refuses admission",
        "oversized native history and diff follow every next_cursor",
        "real path-restricted capability denies an existing unauthorized file",
        "real host materialization, cache hits and eviction",
        "bounded metrics reserve recovery capacity",
    ):
        assert any(criterion in check for check in receipt["checks"]), criterion
    browser = json.loads((output / "browser/receipt.json").read_text())
    assert browser["status"] == "PASS"
    for criterion in (
        "reconnect retains uploading state",
        "page an oversized diff through next_cursor",
        "desktop tablet and mobile widths have no horizontal overflow",
    ):
        assert any(criterion in check for check in browser["checks"]), criterion
    screenshots = {Path(filename).name for filename in browser["screenshots"]}
    for viewport in ("desktop", "tablet", "mobile"):
        for journey in ("checkpoint-unresolved", "checkpoint-acknowledged", "diff-complete", "workspace-accepted", "workspace-exported"):
            name = f"{viewport}-{journey}.png"
            assert name in screenshots, name
            artifact = output / "browser" / name
            assert artifact.stat().st_size > 0, name
            assert artifact.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"), name


def test_host_checkpoint_submission_and_reopen():
    # The focused actor grants its OPERATOR runner.dispatch.consume only for
    # inputs.ids.run (scope.run_id), which enrollment uses for guardFleetLaunch.
    # The bound RUNNER delegates with identity.worker.source.delegate in that
    # same run; the issued WORKER checkpoints with source.workspaces.checkpoint.
    # That WORKER and its matching managed workspace capability also receive
    # source.objects.read/inspect and source.trees.lookup/entries in inputs.ids.run
    # so the real host materializer can read the assigned baseline before editing.
    # The running Node actor is registered with its observed PID and process start
    # identity before receiving host reads, which are unavailable before launch.
    if not os.environ.get("DATABASE_URL"):
        result = subprocess.run([
            sys.executable, str(ROOT / "tests/hyperfide/support/withpg.py"), "--",
            sys.executable, "-m", "pytest", str(Path(__file__).resolve()) +
            "::test_host_checkpoint_submission_and_reopen", "-q",
        ], cwd=ROOT)
        assert result.returncode == 0
        return
    environment = {
        "HF_SOURCE_HOST_CHECKPOINT": "1",
        "NODE_OPTIONS": "--import=" + str(ROOT / "node_modules/tsx/dist/loader.mjs") + " --conditions=source",
    }
    previous = {key: os.environ.get(key) for key in environment}
    os.environ.update(environment)
    try:
        result = fixture.run_source_assignment_actor(
            ROOT / "tests/hyperfide/support/native_source_product_actor.mjs",
            migrations=fixture.default_source_migrations(), timeout=300,
        )
        assert result == 0, f"Host checkpoint actor exited {result}"
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main():
    inside_owned_database = bool(os.environ.get("DATABASE_URL"))
    environment = {
        "HF_SOURCE_BROWSER": "1",
        "NODE_OPTIONS": "--import=" + str(ROOT / "node_modules/tsx/dist/loader.mjs") + " --conditions=source",
    }
    result = fixture.run_source_actor(
        ROOT / "tests/hyperfide/support/native_source_product_actor.mjs",
        timeout=180,
        actor_env=environment,
    )
    if not inside_owned_database:
        return result
    if result != 0:
        return result
    source_product_evidence()
    if os.environ.get("HF_SOURCE_PRODUCT_CLI", "1") == "0":
        return 0
    build = subprocess.run(["node", str(ROOT / "tools/workspace/build-package.mjs")], cwd=ROOT / "sdk/source-control")
    if build.returncode != 0:
        return build.returncode
    # The bundled environment plugin imports the SDK's published runtime entries.
    sdk_build = subprocess.run(["node", "scripts/build-runtime.mjs"], cwd=ROOT / "sdk/plugins")
    if sdk_build.returncode != 0:
        return sdk_build.returncode
    plugin_build = subprocess.run(["node", "prepare.mjs"], cwd=ROOT / "plugins/environment-slices")
    if plugin_build.returncode != 0:
        return plugin_build.returncode
    child_env = {key: value for key, value in os.environ.items() if key not in ("DATABASE_URL", "HF_SOURCE_QUALIFICATION")}
    child_env["HF_SOURCE_PRODUCT_CLI"] = "1"
    return subprocess.run([sys.executable, str(ROOT / "tests/hyperfide/cases/source_control/signed_transport.py")], cwd=ROOT, env=child_env).returncode


if __name__ == "__main__":
    raise SystemExit(main())
