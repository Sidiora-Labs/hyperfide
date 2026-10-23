#!/usr/bin/env python3
"""Fleet A -> (B, C), through bundles, parallel workers and tagged merges."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'support'))
from platform_fixture import PlatformBuildAbsent, run_fleet


def main():
    try:
        result = run_fleet()
    except PlatformBuildAbsent as error:
        print(f'SKIP: {error}')
        return 77
    assert result['first'] == ['A'], result
    assert result['beforeCollect'] == [], 'dependency released before integration'
    assert result['second'] == ['B', 'C']
    assert result['peak'] == 2
    assert result['statuses'] == dict.fromkeys('ABC', 'implemented')
    image = result['image']
    assert image['commit'] == result['initial']
    assert image['checkpoint'] == 'hf-base-' + result['initial'][:10]
    assert [s['name'] for s in image['steps']] == ['clone', 'cg', 'service', 'platform', 'index', 'tools']
    assert all(s['state'] == 'succeeded' and s['duration'] >= 0 for s in image['steps'])
    jobs = {job['task']: job for job in result['ledgers']}
    assert set(jobs) == set('ABC')
    assert len({job['machine'] for job in jobs.values()}) == 3
    for task, job in jobs.items():
        assert job['state'] == 'merged' and job['attempt'] == 1
        assert job['log'] == [f'echo {task}']
        assert [e['state'] for e in job['timeline']] == ['created', 'prepared', 'running', 'packed', 'collected', 'merged']
    assert jobs['B']['base'] == jobs['C']['base'] == jobs['A']['merge']
    assert jobs['B']['key'] != jobs['C']['key']
    assert jobs['A']['timeline'][-1]['sequence'] < jobs['B']['timeline'][0]['sequence']
    assert max(jobs[t]['timeline'][2]['sequence'] for t in 'BC') < min(jobs[t]['timeline'][3]['sequence'] for t in 'BC')
    assert {j['task']: j['state'] for j in result['parallelSnapshot']} == {'A': 'merged', 'B': 'packed', 'C': 'packed'}
    previous = result['initial']
    for merge in result['merges']:
        assert merge['message'] == f"Integrate {merge['task']} [spec:fleet/{merge['task']}]"
        assert merge['parents'] == [previous, merge['worker']]
        assert merge['content'] == f"echo {merge['task']}"
        previous = merge['hash']
    dashboard = result['dashboard']
    assert dashboard['jobs'] == result['ledgers']
    assert dashboard['image'] == image
    assert dashboard['budget'] == {'cap': 2, 'inFlight': 0, 'keys': 2, 'backoffUntil': None}
    assert len(dashboard['machines']) == 4
    assert all(m['provider'] == 'fake' and m['state'] == 'destroyed' for m in dashboard['machines'])
    print('PASS: fleet image, A -> (B, C), ledgers, tagged merges, spec statuses and dashboard RPC')
    return 0


if __name__ == '__main__':
    sys.exit(main())
