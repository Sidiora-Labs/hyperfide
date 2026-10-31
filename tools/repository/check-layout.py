#!/usr/bin/env python3
"""Check source conservation in the relocated workspace; no runtime qualification."""
from pathlib import Path
import hashlib
import json
import os
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
MAPPING = ROOT / 'spec/hyperfide-source-control/repository-layout.json'


def main():
    mapping = json.loads(MAPPING.read_text())
    baseline = mapping['implementation_baseline']
    rules = sorted(mapping['mappings'], key=lambda r: len(r['source']), reverse=True)
    raw = subprocess.check_output(['git', 'ls-tree', '-r', '-z', baseline], cwd=ROOT)
    errors, changed, preserved, merged = [], [], 0, {}
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        source = name.decode()
        rule = next((r for r in rules if source == r['source'] or source.startswith(r['source'] + '/')), None)
        target = rule['destination'] + source[len(rule['source']):] if rule else source
        path = ROOT / target
        merged.setdefault(target, []).append(source)
        if not path.exists() and not path.is_symlink():
            errors.append(f'missing: {source} -> {target}')
            continue
        info = path.lstat()
        actual_mode = '120000' if stat.S_ISLNK(info.st_mode) else '100755' if info.st_mode & 0o111 else '100644'
        if mode != actual_mode:
            errors.append(f'mode changed: {source}: {mode} -> {actual_mode}')
        if kind != 'blob':
            errors.append(f'unsupported Git entry: {source}: {kind}')
            continue
        data = os.readlink(path).encode() if actual_mode == '120000' else path.read_bytes()
        object_id = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if object_id == oid:
            preserved += 1
        else:
            changed.append({'source': source, 'target': target, 'before_blob': oid,
                            'after_blob': object_id, 'classification': 'rewrite-requires-review'})
    for container in ['platform', 'services', 'src', 'scripts', 'kvx', 'editors']:
        if (ROOT / container).exists():
            errors.append(f'obsolete source container remains: {container}')
    for category in ['core','sdk','apps','contracts','lib','plugins','extensions','tools','examples']:
        if not (ROOT / category).is_dir():
            errors.append(f'missing category: {category}')
    report = {'schema_version': 1, 'scope': 'workspace-path-and-mode-conservation',
              'baseline': baseline, 'status': 'FAIL' if errors else 'PASS',
              'checked_source_files': preserved + len(changed), 'unchanged_blob_count': preserved,
              'rewrites': changed, 'merge_targets': {k:v for k,v in merged.items() if len(v)>1},
              'errors': errors, 'full_layout_qualification': 'UNRUN',
              'note': 'Existence and mode conservation do not establish correctness of rewrites or runtime behavior.'}
    out = ROOT / 'build/layout/workspace/structure-receipt.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k not in {'rewrites','merge_targets'}},indent=2))
    return int(bool(errors))


if __name__ == '__main__':
    sys.exit(main())
