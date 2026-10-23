#!/usr/bin/env python3
"""Local projection of the wave 0 identity gate, removable when 0.7 merges.

Checks introduced lines in --changed mode, including untracked source files.
Patterns are encoded so this checker cannot introduce a forbidden identity.
"""
import argparse
import base64
import json
import re
import subprocess
from pathlib import Path

PATTERNS = 'WyJAYmIvIiwgIkBnZXQtYmIvIiwgIlxcYkJCX1tBLVpfXSsiLCAiKD88IVtcXHddKVxcLmJiKD89Wy9cXHNcIlxcJ10pIiwgIlxcYmJiLXBsdWdpbi0iLCAiZ2V0LWJiXFwuKD86Y29tfGRldikiLCAiXFxiQkJcXGIiXQ=='

def git(*args):
    return subprocess.check_output(["git", *args], text=True)

parser = argparse.ArgumentParser()
parser.add_argument("--changed", nargs="?", const="a176a40fe57166542582420ce7b9bb62769ac55c")
args = parser.parse_args()
patterns = [re.compile(p) for p in json.loads(base64.b64decode(PATTERNS))]
paths = set(git("ls-files", "-z").split("\0"))
if args.changed:
    paths = set(git("diff", "--name-only", args.changed, "-z").split("\0"))
    paths.update(git("ls-files", "--others", "--exclude-standard", "-z").split("\0"))
failed = False
for name in sorted(paths):
    path = Path(name)
    if not name or name.startswith("licenses/") or not path.is_file():
        continue
    try:
        content = path.read_text()
    except UnicodeError:
        continue
    if args.changed:
        # The projection must enforce no reintroduction before the identity sweep lands.
        diff = git("diff", "--unified=0", args.changed, "--", name)
        if diff:
            content = "\n".join(line[1:] for line in diff.splitlines()
                                if line.startswith("+") and not line.startswith("+++"))
    for number, line in enumerate(content.splitlines(), 1):
        if any(pattern.search(line) for pattern in patterns):
            print(f"{name}:{number}: forbidden identity: {line}")
            failed = True
raise SystemExit(1 if failed else 0)
