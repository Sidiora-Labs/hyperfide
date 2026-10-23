#!/usr/bin/env python3
"""Reject historical platform identity in tracked paths and text."""

import argparse
import base64
import fnmatch
import os
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[4]
ENCODED_PATTERNS = [
    "W2Etel1CQlxi",
    "JVswLTlBLUZhLWZdezJ9KD86YmJ8QkJ8QmIpKD8hW0EtWmEtejAtOV0p",
    "KD88IVtBLVphLXowLTldKWJiKD86ZGVffGRoX3xjbV98b2NffHRhc2tcYnx0aHJlYWRcYnxhcHBcYnxhZG1pblxifHhcYnxzYVxiKQ==",
    "QkIoPzpTZGt8Q2xpcGJvYXJkfEltYWdlUGFzdGV8QVBQXGJ8U0FcYik=",

    "KD88IVthLXpBLVowLTldKWJiKD89W0EtWl0p",
    "KD88IVtBLVphLXowLTldKSg/OmJifEJCfEJiKSg/IVtBLVphLXowLTldKQ==",
    "QmIoPz1bQS1aXSk=",
    "KD88IVtBLVphLXowLTldKSg/OkJCX3xiYl8p",
    "KD88IVtBLVphLXowLTldKWdldC0/YmIoPyFbQS1aYS16MC05XSk=",
]
PATTERNS = [re.compile(base64.b64decode(p).decode()) for p in ENCODED_PATTERNS]
NEEDLE = base64.b64decode("YmI=").decode()


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args]).decode().split("\0")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--changed", nargs="?", const="HEAD", metavar="COMMIT",
                        help="scan tracked files changed against COMMIT (default HEAD)")
    args = parser.parse_args()
    files = set(filter(None, git("ls-files", "-z")))
    if args.changed:
        files &= set(git("diff", "--name-only", "-z", args.changed, "--"))
    exceptions = []
    for number, line in enumerate(Path(__file__).with_name("identity_allowlist.txt").read_text().splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 3 or not fields[2].strip():
            parser.error(f"allowlist line {number} requires path, regex and reason separated by tabs")
        exceptions.append((fields[0], re.compile(fields[1])))
    hits = 0
    for name in sorted(files):
        if name.startswith("licenses/bb/"):
            continue
        path = ROOT / name
        if not path.exists() and not path.is_symlink():
            continue  # Tracked deletions are absent in the working tree.
        if any(pattern.search(name) for pattern in PATTERNS):
            print(f"{name}:0: historical identifier in path")
            hits += 1
        data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        if b"\0" in data:
            continue
        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(source.splitlines(), 1):
            if NEEDLE not in line.lower():
                continue
            checked = line
            for glob, pattern in exceptions:
                if fnmatch.fnmatchcase(name, glob):
                    checked = pattern.sub("", checked)
            if any(pattern.search(checked) for pattern in PATTERNS):
                print(f"{name}:{number}:{line}")
                hits += 1
    print(f"identity gate: {len(files)} tracked files, {hits} hits")
    return bool(hits)


if __name__ == "__main__":
    raise SystemExit(main())
