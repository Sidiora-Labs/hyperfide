#!/usr/bin/env python3
"""Temporary task-0.7 identity gate adapter; remove when the shared gate lands."""
import argparse
from collections import Counter
import base64
from pathlib import Path
import re
import subprocess

PATTERNS = ['KD88IVtBLVphLXowLTlfXSliYig/IVtBLVphLXowLTlfXSk=', 'QGdldC1iYi8=', 'XGJCQl9bQS1aMC05X10r', 'KD88IVtBLVphLXowLTlfXSlcLmJiXGI=', 'XGJiYi0t', 'XGJiYi1wbHVnaW4t', 'XGJnZXQtYmJcYg==', 'XGJiYlwuZGV2XGI=']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--changed", nargs="?", const="HEAD", required=True)
    args = parser.parse_args()
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    def paths(*arguments):
        return set(subprocess.check_output(["git", "-C", str(root), *arguments]).decode().split("\0")) - {""}
    changed = paths("diff", "--name-only", "-z", args.changed) | paths("ls-files", "--others", "--exclude-standard", "-z")
    checks = [re.compile(base64.b64decode(value).decode(), re.I if index in (0, 6, 7) else 0) for index, value in enumerate(PATTERNS)]
    failures = []
    for name in sorted(changed):
        path = root / name
        if name.startswith("licenses/") or path.name.startswith(".env") or not path.is_file() or path.is_symlink():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue
        # Existing violations belong to the identity sweep; reject every new occurrence.
        previous = subprocess.run(["git", "-C", str(root), "show", f"{args.changed}:{name}"], capture_output=True)
        baseline = Counter(previous.stdout.decode("utf-8", errors="replace").splitlines()) if previous.returncode == 0 else Counter()
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            if baseline[line]:
                baseline[line] -= 1
                continue
            if any(pattern.search(line) for pattern in checks):
                failures.append(f"{name}:{number}: {line}")
    print("\n".join(failures) if failures else f"Identity gate passed ({len(changed)} changed paths)")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
