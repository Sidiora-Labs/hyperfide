#!/usr/bin/env python3
"""Write full-case registrations and registry inventories from compose.py.

    register.py V-NNN...        write registrations/full/V-NNN[.variant].json and
                                the case's full_assertion_ids in registry.json
    register.py --check V-NNN... exit 1 when a written registration or inventory is stale

The registry keeps its json indent=2 layout; only the named cases' inventories change.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compose  # noqa: E402

FULL_DIR = compose.REGISTRATIONS / "full"
MAX_TIMEOUT = 604800


def relative(path):
    return Path(path).resolve().relative_to(compose.ROOT).as_posix()


def registration_name(case, variant):
    return case + ("." + variant if variant else "") + ".json"


def build(case, variant):
    parts = compose.components(case)
    leg = compose.leg_of(case)
    required_env, fixtures, actions, sources, roots, resources, artifacts = set(), set(), set(), set(), set(), [], []
    main_timeout, cleanup_timeout = 300, 60
    for registration, path in parts:
        task = registration["task"]
        required_env.update(registration.get("required_env", []))
        fixtures.update(registration.get("fixtures", []))
        actions.update(registration.get("actions", []))
        sources.update(registration["source_files"])
        sources.add(relative(path))
        roots.update(registration["source_roots"])
        for resource in registration.get("resources", []):
            namespaced = dict(resource)
            namespaced["id"] = task + ":" + resource["id"]
            resources.append(namespaced)
        artifacts.extend("components/" + task + "/" + name for name in registration.get("required_artifacts", []))
        main_timeout += registration.get("timeout_seconds", 60)
        if registration.get("cleanup_argv"):
            cleanup_timeout += registration.get("cleanup_timeout_seconds", 60)
    sources.update([compose.SELF, "tests/hyperfide/cases/full/register.py", "tests/hyperfide/registry.json"])
    task = compose.DEFAULT_TASK
    if leg:
        spec = compose.LEGS[leg]
        required_env.add(compose.leg_env(leg, variant))
        main_timeout += spec["timeout"]
        task = spec["task"]
        if spec["kind"] == "driver":
            sources.update([spec["driver"], "tests/hyperfide/campaigns/deterministic.py"])
    argv = ["python3", compose.SELF, case] + (["--variant", variant] if variant else [])
    registration = {
        "schema_version": 1,
        "variant": "full:" + case + ("@" + variant if variant else ""),
        "task": task,
        "scope": "full-case",
        "cases": [case],
        "assertion_ids": compose.full_inventory(case),
        "argv": argv,
        "timeout_seconds": min(main_timeout, MAX_TIMEOUT),
        "required_env": sorted(required_env),
        "fixtures": sorted(fixtures),
        "actions": sorted(actions),
        "resources": resources,
        "required_artifacts": artifacts,
        "source_files": sorted(sources),
        "source_roots": sorted(roots),
    }
    if compose.has_cleanup(case):
        registration["cleanup_argv"] = argv + ["--cleanup"]
        registration["cleanup_timeout_seconds"] = min(cleanup_timeout, MAX_TIMEOUT)
    return registration


def render(value):
    return json.dumps(value, indent=2) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", nargs="+")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    registry_text = compose.REGISTRY.read_text()
    registry = json.loads(registry_text)
    stale = []
    FULL_DIR.mkdir(exist_ok=True)
    for case in args.cases:
        if case not in registry["cases"]:
            raise SystemExit("unknown case " + case)
        registry["cases"][case]["full_assertion_ids"] = compose.full_inventory(case)
        for variant in compose.variants(case):
            path = FULL_DIR / registration_name(case, variant)
            text = render(build(case, variant))
            if not path.is_file() or path.read_text() != text:
                stale.append(relative(path))
                if not args.check:
                    path.write_text(text)
    new_registry = render(registry)
    if new_registry != registry_text:
        stale.append("tests/hyperfide/registry.json")
        if not args.check:
            compose.REGISTRY.write_text(new_registry)
    for item in stale:
        print(("stale: " if args.check else "wrote: ") + item)
    return 1 if args.check and stale else 0


if __name__ == "__main__":
    raise SystemExit(main())
