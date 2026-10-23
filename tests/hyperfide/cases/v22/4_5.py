#!/usr/bin/env python3
"""Qualification through receipt, closure and permission-gated local publication."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'support'))
from platform_fixture import QualificationProjection, closure_module


def main():
    with QualificationProjection() as platform:
        platform.implement()
        assert 'status = "implemented"' in platform.spec.read_text()
        receipt = platform.qualify()
        stored = json.loads(platform.receipt_path.read_text())
        assert stored == receipt
        assert stored['task'] == '1.1' and stored['exit'] == 0
        assert stored['duration'] >= 0 and stored['toolchain']['node'].startswith('v24.')
        assert stored['source']['commit'] == platform.git('rev-parse', 'HEAD').stdout.strip()
        closure = closure_module()
        assert stored['seal'] == closure.sha(closure.canonical(
            {k: v for k, v in stored.items() if k != 'seal'}))
        assert platform.checker['provider'] != platform.checker['worker']
        for path in stored['evidence_paths']:
            assert (platform.repo / path).is_file(), path
        output = json.loads(platform.closure())
        assert output == {'task': '1.1', 'status': 'PASS', 'failures': []}, output
        # Closure must reject a changed pinned source and recover after restoration.
        platform.write('src/value.txt', 'drift\n')
        assert json.loads(platform.closure())['status'] == 'FAIL'
        try:
            platform.close_wave()
        except RuntimeError as error:
            assert 'closure blocked' in str(error)
        else:
            raise AssertionError('wave closed with source drift')
        platform.write('src/value.txt', 'implemented\n')
        for record, field, rejected, accepted in (
                (platform.lane, 'state', 'failed', 'passed'),
                (platform.checker, 'verdict', 'fail', 'pass')):
            record[field] = rejected
            try:
                platform.close_wave()
            except RuntimeError as error:
                assert 'closure blocked' in str(error)
            else:
                raise AssertionError('wave closed with failed lane or checker')
            record[field] = accepted
        platform.close_wave()
        try:
            platform.publish()
        except PermissionError:
            pass
        else:
            raise AssertionError('push succeeded without permission')
        assert not platform.run(['git', '--git-dir', str(platform.remote),
                                 'for-each-ref'], check=True).stdout.strip()
        platform.run([str(Path(__file__).resolve().parents[4] / 'cg'),
                      'ask', 'answer', platform.ask_id, 'approve'])
        pushed = platform.publish()
        remote = platform.run(['git', '--git-dir', str(platform.remote),
                               'rev-parse', 'refs/heads/publication']).stdout.strip()
        assert remote == pushed
        assert platform.git('rev-list', '--count', platform.base_commit + '..' + pushed).stdout.strip() == '1'
        assert platform.git('show', pushed + ':src/value.txt').stdout == 'implemented\n'
        assert 'status = "done"' in platform.git('show', pushed + ':spec/hyperfide/spec.kvx').stdout
        assert platform.git('show', '-s', '--format=%P', pushed).stdout.strip() == platform.base_commit
        assert '[spec:hyperfide/1.1]' in platform.git('show', '-s', '--format=%B', pushed).stdout
        print('closure_check ' + json.dumps(output, sort_keys=True))
        print('PASS qualification: implemented, lane, checker, receipt, wave, permission Ask, local squash push')


if __name__ == '__main__':
    main()
