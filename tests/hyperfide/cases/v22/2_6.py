#!/usr/bin/env python3
"""Run a spec task through a built platform and its enrolled host daemon."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'support'))
from platform_fixture import SpecBuildAbsent, SpecFixture


def main():
    try:
        with SpecFixture() as fixture:
            assert fixture.rpc('status')['status'] == 'pending'
            started = fixture.rpc('runTask', {'projectId': fixture.project_id,
                'hostId': fixture.host_id, 'providerId': 'echo-agent'})
            assert started['threadId']
            for text in ('requires', 'touches', 'verify_cmd', 'do_1', 'CG_TASK=fixture/1'):
                assert text in started['packet'], text
            fixture.wait(lambda: fixture.rpc('status')['status'] == 'implemented', 'provider status write')
            thread = fixture.wait(lambda: (t if (t := fixture.request(
                '/api/v1/threads/' + started['threadId']))['status'] == 'idle' else None), 'thread completion')
            assert thread['providerId'] == 'echo-agent', thread
            assert 'status = "implemented"' in fixture.spec.read_text()
            assert (fixture.repo / 'worker.txt').read_text() == 'fixture/1'
            journal_path = fixture.repo / '.codegraph/spec-projection-journal.jsonl'
            fixture.wait(lambda: 'thread.finished' in journal_path.read_text(), 'finished thread journal')
            journal = [json.loads(line) for line in journal_path.read_text().splitlines()]
            assert any(e['event'] == 'task.started' and e['threadId'] == started['threadId'] for e in journal)
            assert any(e['event'] == 'provider.implemented' and e['status'] == 'implemented'
                       and e['cwd'] == str(fixture.repo) for e in journal)
            assert any(e['event'] == 'thread.finished' and e['status'] == 'implemented' for e in journal)
        assert not fixture.root.exists(), 'temporary platform state leaked'
        assert all(process.poll() is not None for process in fixture.processes), 'platform process leaked'
    except SpecBuildAbsent as error:
        print('SKIP 77 ' + str(error))
        return 77
    print('PASS spec RPC -> managed thread -> echo provider -> implemented and journal')
    return 0


if __name__ == '__main__':
    sys.exit(main())
