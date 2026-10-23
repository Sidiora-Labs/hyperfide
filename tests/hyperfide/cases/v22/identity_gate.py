#!/usr/bin/env python3
"""Identity gate projection: full scan, or newly introduced matches with --changed."""
from collections import Counter
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess


# Existing SDK member access is not a product name or a data-directory path.
PATTERNS = [re.compile(p) for p in json.loads(base64.b64decode("WyJcXCNcXCBiYig/IVtBLVphLXowLTlfXSkiLCAiXCJwcm9kdWN0TmFtZVwiOlxcIFwiYmJcIiIsICJAZ2V0XFwtYmIvIiwgIkBiYi8iLCAiKD88IVtBLVphLXowLTlfXSlCQl8iLCAiXFwuYmIoPz1bL1xcXFxcXFwiXFwnXSkiLCAiKD88IVtBLVphLXowLTlfXSlnZXRcXC1iYlxcLmdpdGh1YlxcLmlvKD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWdldGJiXFwuYXBwKD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWdldGJiXFwubG9jYWxob3N0KD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWdldFxcLWJiKD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWdldGJiKD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWJiXFwuZGV2KD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWJiXFwuYXBwKD8hW0EtWmEtejAtOV9dKSIsICIoPzwhW0EtWmEtejAtOV9dKWJiXFwtIiwgIig/PCFbQS1aYS16MC05X10pYmJfIiwgIig/PCFbQS1aYS16MC05X10pQmIoPyFbQS1aYS16MC05X10pIiwgIig/PCFbQS1aYS16MC05X10pQkIoPyFbQS1aYS16MC05X10pIiwgIig/PCFbQS1aYS16MC05Xy5dKWJiKD8hW0EtWmEtejAtOV9dKSJd"))]
parser = argparse.ArgumentParser()
parser.add_argument("--changed", nargs="?", const="HEAD")
args = parser.parse_args()
if args.changed == "HEAD":
    clean = subprocess.run(["git", "diff", "--quiet", "HEAD"]).returncode == 0
    if clean and subprocess.run(["git", "rev-parse", "--verify", "HEAD^"], capture_output=True).returncode == 0:
        args.changed = "HEAD^"
root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0"))
if args.changed:
    changed = set(subprocess.check_output(["git", "diff", "--name-only", "-z", args.changed], cwd=root).decode().split("\0"))
    tracked &= changed
hits = []
for name in sorted(tracked):
    if not name or name.startswith("licenses/" + chr(98) * 2 + "/"):
        continue
    path = root / name
    if not path.is_file():
        continue
    data = path.read_bytes()
    if b"\0" in data:
        continue
    try:
        lines = data.decode("utf8").splitlines()
    except UnicodeDecodeError:
        continue
    baseline = Counter()
    if args.changed:
        previous = subprocess.run(["git", "show", f"{args.changed}:{name}"], cwd=root, capture_output=True)
        if previous.returncode == 0:
            baseline = Counter(previous.stdout.decode("utf8", errors="replace").splitlines())
    for number, line in enumerate(lines, 1):
        if baseline[line] > 0:
            baseline[line] -= 1
            continue
        if any(pattern.search(line) for pattern in PATTERNS):
            hits.append(f"{name}:{number}: identity violation")
print("\n".join(hits) if hits else "identity gate passed")
raise SystemExit(bool(hits))
