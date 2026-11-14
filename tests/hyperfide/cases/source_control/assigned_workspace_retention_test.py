#!/usr/bin/env python3
"""Prove an assigned native workspace retains its base through its first checkpoint."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location(
    'native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def test_assigned_workspace_retention():
    result = fixture.run_source_assignment_actor(
        ROOT / 'tests/hyperfide/support/native_source_assignment_retention_actor.mjs',
        migrations=[
            '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
            '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
            '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
            '0742-source-control-publication.sql', '0743-source-control-assurance.sql',
            '0746-source-control-retention.sql', '0757-source-control-candidate-queue.sql',
        ])
    assert result == 0, f'Assigned workspace retention actor exited {result}'


if __name__ == '__main__':
    test_assigned_workspace_retention()
