#!/usr/bin/env python3
"""Actual root-owned native snapshot storage; fixtures never claim qualification."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/fleet/connector-snapshot'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def main():
    if os.geteuid() != 0:
        print(json.dumps({'status': 'SKIP', 'reason': 'actual root metadata ownership required'}))
        return 77
    OUT.mkdir(parents=True, exist_ok=True)
    source = OUT / 'snapshot-store.c'
    source.write_text('''#include "supervisor.h"
#include <stdio.h>
int main(int n,char **v){char destination[4096];if(n!=5)return 2;
return hf_fleet_launch_store(v[1],v[2],v[3],v[4],destination,sizeof destination)?0:1;}
''')
    subprocess.run(['make', 'build/libcg.a', 'CFLAGS=-O2 -Werror'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    executable = OUT / 'snapshot-store'
    subprocess.run(['cc', '-O2', '-Werror', '-Icore/native/src/hyperfide', str(source), 'build/libcg.a', '-lsqlite3', '-lpthread', '-lm', '-lcurl', '-lcrypto', '-o', str(executable)], cwd=ROOT, check=True)
    checks = []

    def check(name, value):
        checks.append({'id': name, 'status': 'PASS' if value else 'FAIL'})
        if not value:
            raise AssertionError(name)

    with tempfile.TemporaryDirectory(prefix='hf-native-snapshot-', dir=OUT) as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        binary = ROOT / 'build/fleet/worker/private/claude-2.1.300'
        if not binary.is_file():
            raise RuntimeError('actual pinned worker CLI artifact required')
        snapshot = {'schema_version': 1, 'profile_id': 'declared-only', 'profile_digest': digest(b'declared-only-unqualified-profile'), 'connector': 'claude', 'requested_model_id': 'declared-model', 'configured_provider_id': 'declared-gateway', 'binary': {'path': str(binary), 'digest': digest(binary.read_bytes()), 'version': '2.1.300'}, 'qualification': {'state': 'UNQUALIFIED', 'live_qualified': False, 'receipt_digest': None}}
        plan = {'profile_digest': snapshot['profile_digest'], 'auth_profile': snapshot['profile_id'], 'connector': snapshot['connector'], 'requested_model_id': snapshot['requested_model_id'], 'configured_provider_id': snapshot['configured_provider_id'], 'binary_digest': snapshot['binary']['digest'], 'argv': [snapshot['binary']['path']], 'auth_profile_snapshot': snapshot}

        def store(value, launch=None):
            launch = launch or str(uuid.uuid4())
            payload = canonical(value)
            encoded = base64.urlsafe_b64encode(payload).rstrip(b'=').decode()
            result = subprocess.run([str(executable), str(directory), launch, encoded, digest(payload)], capture_output=True, check=False)
            return launch, result.returncode

        launch, code = store(plan)
        profile = directory / ('connector-profile-' + launch + '.json')
        retained = directory / ('connector-plan-' + launch + '.json')
        check('declared-nonqualified-metadata-retained', code == 0 and snapshot['qualification']['live_qualified'] is False)
        check('profile-exact-byte-identity', profile.read_bytes() == canonical(snapshot))
        check('plan-exact-byte-identity', retained.read_bytes() == canonical(plan))
        info = profile.stat()
        check('profile-root-owner-private-mode-single-inode', info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
        before = (info.st_ino, info.st_mtime_ns)
        _, replay = store(plan, launch)
        after = profile.stat()
        check('exact-replay-preserves-metadata-file', replay == 0 and before == (after.st_ino, after.st_mtime_ns))
        for name, mutate in [('profile-digest', lambda p: p['auth_profile_snapshot'].__setitem__('profile_digest', digest(b'other-profile'))), ('model', lambda p: p['auth_profile_snapshot'].__setitem__('requested_model_id', 'other-model')), ('binary-digest', lambda p: p['auth_profile_snapshot']['binary'].__setitem__('digest', digest(b'other-binary'))), ('binary-path', lambda p: p['auth_profile_snapshot']['binary'].__setitem__('path', '/different/declared/cli'))]:
            changed = json.loads(canonical(plan))
            mutate(changed)
            rejected, status = store(changed)
            check(name + '-mismatch-refused', status == 1 and not (directory / ('connector-profile-' + rejected + '.json')).exists())
        changed = json.loads(canonical(plan))
        changed['auth_profile_snapshot']['qualification']['receipt_digest'] = digest(b'changed-declared-metadata')
        _, conflict = store(changed, launch)
        check('same-launch-changed-bytes-refused', conflict == 1 and profile.read_bytes() == canonical(snapshot) and retained.read_bytes() == canonical(plan))
        linked = str(uuid.uuid4())
        sentinel = directory / 'sentinel'
        sentinel.write_bytes(b'keep')
        sentinel.chmod(0o600)
        (directory / ('connector-profile-' + linked + '.json')).symlink_to(sentinel)
        _, refused = store(plan, linked)
        check('snapshot-symlink-refused-without-overwrite', refused == 1 and sentinel.read_bytes() == b'keep')
    report = {'status': 'PASS', 'scope': 'actual compiled root-owned metadata store; no native qualification or provider execution asserted', 'assertions': checks}
    (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'assertions': len(checks)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
