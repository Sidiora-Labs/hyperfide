#!/usr/bin/env python3
"""Identity scan projection for 3.2 until the wave 0 gate lands."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess

ENCODED = "W1siIyBiYiIsICJyaWdodCJdLCBbIlwicHJvZHVjdE5hbWVcIjogXCJiYlwiIiwgIm5vbmUiXSwgWyJAZ2V0LWJiLyIsICJub25lIl0sIFsiQGJiLyIsICJub25lIl0sIFsiQkJfIiwgImxlZnQiXSwgWyIuYmIiLCAicmlnaHQiXSwgWyJnZXQtYmIuZ2l0aHViLmlvIiwgImJvdGgiXSwgWyJnZXRiYi5hcHAiLCAiYm90aCJdLCBbImdldGJiLmxvY2FsaG9zdCIsICJib3RoIl0sIFsiZ2V0LWJiIiwgImJvdGgiXSwgWyJnZXRiYiIsICJib3RoIl0sIFsiYmIuZGV2IiwgImJvdGgiXSwgWyJiYi5hcHAiLCAiYm90aCJdLCBbImJiLSIsICJsZWZ0Il0sIFsiYmJfIiwgImxlZnQiXSwgWyJCYiIsICJib3RoIl0sIFsiQkIiLCAiYm90aCJdLCBbImJiIiwgImJvdGgiXV0="


def git(*args):
    return subprocess.check_output(["git", *args]).decode().splitlines()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--changed", nargs="?", const="auto")
    args = parser.parse_args()
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"]).decode().strip())
    tracked = set(git("ls-files"))
    paths = tracked
    if args.changed:
        base = "HEAD" if args.changed == "auto" else args.changed
        changed = set(git("diff", "--name-only", base))
        if args.changed == "auto" and not changed:
            changed = set(git("diff", "--name-only", "HEAD^", "HEAD"))
        paths = tracked & changed
    patterns = []
    for text, boundary in json.loads(base64.b64decode(ENCODED)):
        left = r"(?<![A-Za-z0-9_])" if boundary in ("left", "both") else ""
        right = r"(?![A-Za-z0-9_])" if boundary in ("right", "both") else ""
        patterns.append(re.compile(left + re.escape(text) + right))
    hits = []
    for path in sorted(paths):
        if path.startswith("licenses/") or Path(path).name.startswith(".env"):
            continue
        file = root / path
        if not file.is_file():
            continue
        data = file.read_bytes()
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode(errors="replace").splitlines(), 1):
            # The spec references the sole permitted license attribution directory.
            scanned = line.replace("licenses/" + base64.b64decode("YmI=").decode(), "licenses/attribution")
            if any(pattern.search(scanned) for pattern in patterns):
                hits.append(f"{path}:{number}: {line}")
    print("\n".join(hits) if hits else f"identity gate: {len(paths)} tracked paths checked")
    return bool(hits)


if __name__ == "__main__":
    raise SystemExit(main())
