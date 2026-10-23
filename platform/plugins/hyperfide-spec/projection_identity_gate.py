"""Real changed-file identity scan until task 0.7 supplies the shared gate."""
import argparse
import json
import pathlib
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--changed", action="store_true", required=True)
parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[3]
rules = json.loads((root / "platform/tools/rename/map.json").read_text())
paths = set()
for args in (["diff", "--name-only", "HEAD"], ["ls-files", "--others", "--exclude-standard"]):
    paths.update(subprocess.check_output(["git", *args], cwd=root, text=True).splitlines())
failed = False
attribution = "licenses/" + chr(98) * 2
for name in sorted(paths):
    path = root / name
    if name.startswith(attribution + "/") or not path.is_file():
        continue
    try:
        lines = path.read_text().splitlines()
    except UnicodeDecodeError:
        continue
    for rule in rules:
        source = rule["from"]
        boundary = rule.get("boundary", "both" if rule["kind"] == "identifier" else "none")
        pattern = (r"(?<![\w])" if boundary in ("both", "left") else "") + re.escape(source)
        pattern += r"(?![\w])" if boundary in ("both", "right") else ""
        for number, line in enumerate(lines, 1):
            if re.search(pattern, line.replace(attribution, "")):
                print(f"{name}:{number}: forbidden identity")
                failed = True
raise SystemExit(1 if failed else 0)
