"""Run authority client tests against the actual built control service."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location("identity_fixture", ROOT / "tests/hyperfide/support/identity_fixture.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def prepare(fixture):
    config = json.loads(fixture.identity_config.read_text())
    principal = copy.deepcopy(config["principals"][0])
    principal["credential_id"] = str(uuid.uuid4())
    principal["actor_id"] = principal["credential_id"]
    principal["public_key_b64"] = fixture.keys["other"]["public_key_b64"]
    fixture.seed_fixture_principal(principal)
    fixture.ids["unlisted"] = principal["credential_id"]

with_fixture = module.IdentityFixture(extra_components=["platform-authority"], extra_setup=prepare)
try:
    fixture = with_fixture
    config = {"url": fixture.origin, "caFile": str(fixture.ca),
              "keyFile": str(fixture.keys["operator"]["path"]),
              "credentialId": fixture.ids["operator"], "runId": fixture.ids["run"]}
    env = os.environ.copy()
    env["HYPERFIDE_AUTHORITY_TEST_CONFIG"] = json.dumps(config)
    env["HYPERFIDE_AUTHORITY_TEST_UNLISTED"] = json.dumps({**config,
        "keyFile": str(fixture.keys["other"]["path"]), "credentialId": fixture.ids["unlisted"]})
    env["HYPERFIDE_AUTHORITY_TEST_ROOT"] = str(ROOT)
    env["HYPERFIDE_AUTHORITY_TEST_DATABASE_URL"] = fixture.url
    subprocess.run(["pnpm", "-C", "platform", "exec", "vitest", "run", "--config",
        str(ROOT / "platform/packages/hyperfide-authority/vitest.config.ts"), "--root", str(ROOT / "platform/packages/hyperfide-authority")],
        cwd=ROOT, env=env, check=True)
    subprocess.run(["node", "--conditions=source", "--import", "tsx",
        "packages/hyperfide-authority/test/server-bridge.mjs"],
        cwd=ROOT / "platform", env=env, check=True)
finally:
    with_fixture.close()
