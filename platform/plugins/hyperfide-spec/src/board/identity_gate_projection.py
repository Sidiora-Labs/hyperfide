#!/usr/bin/env python3
"""Local task 0.7 projection: scan changed tracked files until its gate lands."""
import argparse
import base64
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--changed', action='store_true', required=True)
parser.add_argument('--base', default='aaeb8230ce2e5217e1717ed876e28259da633127')
args = parser.parse_args()
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
tracked = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0'))
changed = set(subprocess.check_output(['git', 'diff', '--name-only', '-z', args.base], cwd=root).decode().split('\0'))
# Encoded identifiers keep the gate itself free of the forbidden identity.
identifiers = [base64.b64decode(value).decode() for value in (
    'QGdldC1iYi8=', 'QGJiLw==', 'QkJf', 'LmJi', 'YmIt', 'YmJf',
    'YmIuZGV2', 'YmIuYXBw', 'Z2V0LWJiLmdpdGh1Yi5pbw==',
    'Z2V0YmIuYXBw', 'Z2V0YmIubG9jYWxob3N0', 'Z2V0LWJi', 'Z2V0YmI=', 'YmI=',
)]
patterns = [re.compile(r'(?<![A-Za-z0-9_])' + re.escape(value)
                       + (r'(?![A-Za-z0-9_])' if value[-1].isalnum() else ''), re.I)
            for value in identifiers]
failures = []
for name in sorted(tracked & changed):
    path = root / name
    if not name or name.startswith('licenses/') or not path.is_file():
        continue
    for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
        if any(pattern.search(line) for pattern in patterns):
            failures.append(f'{name}:{number}: {line}')
print('\n'.join(failures) if failures else 'Identity gate passed (local projection)')
raise SystemExit(bool(failures))
