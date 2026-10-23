#!/usr/bin/env python3
"""Task 0.7 projection: check added identity text using the existing rename map.

The canonical gate replaces this file when task 0.7 lands. The pending runtime
API migration (property names and SDK types) is outside task 3.4; the public
identity rules still run over every added line, including untracked sources.
"""
import argparse
import fnmatch
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--changed", action="store_true", required=True)
    parser.add_argument("--base", default="3a85072eb82e06eaf6693bd007ea5432270892f3")
    args = parser.parse_args()
    rules = json.loads((ROOT / "platform/tools/rename/map.json").read_text())
    paths = set(git("diff", "--name-only", args.base).splitlines())
    paths.update(git("ls-files", "--others", "--exclude-standard").splitlines())
    failures = []
    for path in sorted(paths):
        file = ROOT / path
        if not file.is_file() or file.name.startswith(".env"):
            continue
        try:
            current = file.read_text()
        except (UnicodeError, OSError):
            continue
        # Track additions against the task base; existing migration debt belongs
        # to task 0.7, whose canonical gate scans the resulting whole files.
        tracked = bool(git("ls-files", "--", path).strip())
        if tracked:
            diff = git("diff", "--unified=0", args.base, "--", path)
            lines = [line[1:] for line in diff.splitlines()
                     if line.startswith("+") and not line.startswith("+++")]
        else:
            lines = current.splitlines()
        for rule in rules:
            if rule["kind"] == "path" or "before" in rule or "after" in rule:
                continue
            if not any(fnmatch.fnmatch(path, glob) for glob in rule["paths"]):
                continue
            source = rule["from"]
            boundary = rule.get("boundary", "both" if rule["kind"] == "identifier" else "none")
            left = r"(?<![A-Za-z0-9])" if boundary in ("left", "both") else ""
            right = r"(?![A-Za-z0-9_])" if boundary in ("right", "both") else ""
            # A data-directory identity is a path, rather than an SDK accessor.
            if source.startswith("."):
                left = r"(?<![A-Za-z0-9_])"
            pattern = re.compile(left + re.escape(source) + right)
            for line in lines:
                if pattern.search(line):
                    failures.append(f"{path}: identity must use {rule['to']}: {line.strip()}")
    print("\n".join(failures) if failures else "identity gate: changed additions pass")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
