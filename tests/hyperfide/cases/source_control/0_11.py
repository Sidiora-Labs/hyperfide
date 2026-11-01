#!/usr/bin/env python3
"""Exercise the scoped Git transfer boundary with real Git and filesystems.

This component gate protects authorized source selection, content identity,
dirty preservation and isolation. It cannot certify signed installation or a
provider sandbox; those journeys require the live fleet prerequisite campaign.
"""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/fleet/0.11'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    command = ['node', str(Path(__file__).parent / 'fixtures/install/source_manifest.mjs')]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    (OUT / 'source-adapter.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    report = json.loads(result.stdout)
    inventory = subprocess.run(['node', str(Path(__file__).parent / 'fixtures/install/installed_inventory.mjs')], cwd=ROOT, capture_output=True, text=True)
    (OUT / 'installed-inventory.log').write_text(inventory.stdout + inventory.stderr)
    if inventory.returncode:
        print(inventory.stderr, file=sys.stderr)
        return inventory.returncode
    report['assertions'].update({name: True for name in json.loads(inventory.stdout)['assertions']})
    report.update(task='0.11', scope='scoped Git and installed closure filesystem components only',
                  signed_environment_installation='UNRUN', provider_qualification='UNRUN')
    (OUT / 'source-adapter-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'assertions': len(report['assertions']),
                      'signed_environment_installation': 'UNRUN', 'provider_qualification': 'UNRUN'}))
    return 0

if __name__ == '__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.11', main, ROOT / 'build/fleet/0.11'))
