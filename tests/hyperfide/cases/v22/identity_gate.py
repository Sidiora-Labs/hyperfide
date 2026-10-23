#!/usr/bin/env python3
"""Identity projection until task 0.7 lands; changed mode rejects introduced hits.

The base tree still contains identity debt. Existing lines are subtracted only in
changed mode; the full-tree scan reports every hit. Patterns are encoded so the
scanner does not exempt itself.
"""
import argparse
import base64
from collections import Counter
from pathlib import Path
import re
import subprocess

ENCODED = ['XCNcIGJiKD8hW0EtWmEtejAtOV9dKQ==', 'InByb2R1Y3ROYW1lIjpcICJiYiI=', 'QGdldFwtYmIv', 'QGJiLw==', 'KD88IVtBLVphLXowLTlfXSlCQl8=', 'XC5iYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSlnZXRcLWJiXC5naXRodWJcLmlvKD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSlnZXRiYlwuYXBwKD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSlnZXRiYlwubG9jYWxob3N0KD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSlnZXRcLWJiKD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSlnZXRiYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYlwuZGV2KD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSliYlwuYXBwKD8hW0EtWmEtejAtOV9dKQ==', 'KD88IVtBLVphLXowLTlfXSliYlwt', 'KD88IVtBLVphLXowLTlfXSliYl8=', 'KD88IVtBLVphLXowLTlfXSlCYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSlCQig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=']


def git(*args):
    return subprocess.check_output(['git', *args])


def hits(text, patterns):
    return [(number, line) for number, line in enumerate(text.splitlines(), 1)
            if any(pattern.search(line) for pattern in patterns)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--changed', nargs='?', const='a176a40fe57166542582420ce7b9bb62769ac55c')
    args = parser.parse_args()
    patterns = [re.compile(base64.b64decode(value).decode(), re.I) for value in ENCODED]
    root = Path(git('rev-parse', '--show-toplevel').decode().strip())
    if args.changed:
        paths = set(git('diff', '--name-only', '-z', args.changed).decode().split('\0'))
        paths.update(git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0'))
    else:
        paths = set(git('ls-files', '-z').decode().split('\0'))
    failures = 0
    for path in sorted(paths):
        if not path or path.startswith(base64.b64decode('bGljZW5zZXMvYmIv').decode()) or not (root / path).is_file():
            continue
        data = (root / path).read_bytes()
        if b'\0' in data:
            continue
        existing = Counter()
        if args.changed:
            old = subprocess.run(['git', 'show', f'{args.changed}:{path}'], capture_output=True)
            if old.returncode == 0:
                existing.update(line for _, line in hits(old.stdout.decode(errors='replace'), patterns))
        for number, line in hits(data.decode(errors='replace'), patterns):
            if existing[line]:
                existing[line] -= 1
                continue
            print(f'{path}:{number}: {line}')
            failures += 1
    print(f'identity gate: {failures} introduced hits' if args.changed else f'identity gate: {failures} hits')
    return int(failures > 0)


if __name__ == '__main__':
    raise SystemExit(main())
