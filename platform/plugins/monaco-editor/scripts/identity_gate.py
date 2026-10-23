#!/usr/bin/env python3
"""Task-local projection of the wave-0 identity gate; remove when it lands."""
import argparse
import base64
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--changed", nargs="?", const="aaeb8230ce2e5217e1717ed876e28259da633127")
args = parser.parse_args()
def git(*arguments):
    return subprocess.check_output(["git", *arguments]).decode().splitlines()
tracked = set(git("ls-files"))
paths = tracked
if args.changed:
    paths = (set(git("diff", "--name-only", args.changed)) | set(git("ls-files", "--others", "--exclude-standard")))
patterns = [re.compile(base64.b64decode(value).decode(), re.I) for value in ['XGJiYWNrYm9hcmRcYg==', 'KD88IWxpY2Vuc2VzLylcYmJiXGI=', 'QGJiLw==', 'XGJnZXQtYmJcYg==', 'XGJnZXRiYlxi', 'XGJCQl9bQS1aX10r', 'XC5iYlxi', 'XGJiYi1bYS16XQ==']]
failures = []
for name in sorted(paths):
    path = Path(name)
    if name.startswith("licenses/") or not path.is_file():
        continue
    try:
        lines = path.read_text().splitlines()
    except (UnicodeError, OSError):
        continue
    for line_number, line in enumerate(lines, 1):
        if any(pattern.search(line) for pattern in patterns):
            failures.append(f"{name}:{line_number}: {line}")
print("\n".join(failures) if failures else "identity gate passed")
raise SystemExit(bool(failures))
