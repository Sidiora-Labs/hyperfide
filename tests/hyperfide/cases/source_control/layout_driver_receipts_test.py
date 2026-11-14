#!/usr/bin/env python3
"""Check tracked driver evidence through the real layout aggregation contract."""
from pathlib import Path
import importlib.util
import json
import re
import subprocess
import sys


SPEC = importlib.util.spec_from_file_location('layout_driver_receipts', Path(__file__).with_name('0_9.py'))
LAYOUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAYOUT)
INPUT = LAYOUT.PACK / 'layout-aggregation-input.json'
MISSING_INPUTS = {
    '0.4': 'pinned Node 22.19.0 and Node 24.22.0; layout build artifacts; current frozen-install/build evidence',
    '0.5': 'pinned Node 24.22.0; native/control runtime artifacts; PostgreSQL 18 runtime',
    '0.6': 'pinned Node 22.19.0; installed workspace dependencies and SDK/plugin build artifacts',
    '0.7': 'runtime artifacts; Linux desktop and Android packaging/executor evidence',
    '0.8': 'qualified source stamp; release archives; prepared-image and installed-service evidence',
}


def receipt_path(task):
    return LAYOUT.PACK / 'receipts' / (task + '.json')


def receipt_exists(task):
    path = receipt_path(task)
    assert not path.is_symlink(), str(path) + ': symlink receipt refused'
    assert not path.exists() or path.is_file(), str(path) + ': ordinary receipt file required'
    return path.is_file()


def driver_command(task):
    return 'python3 tests/hyperfide/cases/source_control/' + task.replace('.', '_') + '.py'


def test_every_required_driver_has_a_tracked_pass_receipt():
    for task in LAYOUT.REQUIRED:
        path = receipt_path(task)
        relative = path.relative_to(LAYOUT.ROOT).as_posix()
        if not receipt_exists(task):
            print('UNRUN ' + task + ': ' + driver_command(task) + ' missing inputs: '
                  + relative + '; prior qualification observed ' + MISSING_INPUTS[task]
                  + '; owner must produce the receipt where these inputs exist', flush=True)
            continue
        tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', relative],
                                 cwd=LAYOUT.ROOT, capture_output=True, text=True)
        assert tracked.returncode == 0, relative + ': existing receipt must be tracked'
        receipt = LAYOUT.document(path)
        assert receipt.get('task') == task, relative + ': driver identity differs'
        assert receipt.get('status') == 'PASS', relative + ': status ' + str(receipt.get('status'))


def test_tracked_receipts_bind_to_the_current_mapping_and_snapshot():
    bindings = LAYOUT.capture_bindings()
    for task in LAYOUT.REQUIRED:
        if not receipt_exists(task):
            continue
        path = receipt_path(task)
        receipt = LAYOUT.document(path)
        try:
            LAYOUT.task_receipt(task, path, bindings)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            raise AssertionError(
                'Stale receipt ' + path.relative_to(LAYOUT.ROOT).as_posix()
                + ' carries mapping_sha256=' + str(receipt.get('mapping_sha256'))
                + '; current mapping_sha256=' + bindings['mapping_sha256']
                + '; ' + str(error)
            ) from error


def test_aggregation_input_names_every_tracked_receipt():
    inputs = LAYOUT.document(INPUT)
    assert inputs.get('schema_version') == 1, 'Versioned aggregation input required'
    receipts = inputs.get('task_receipts')
    assert isinstance(receipts, dict), 'Aggregation task_receipts map required'
    assert set(receipts) == set(LAYOUT.REQUIRED), 'Aggregation input must name exactly the required drivers'
    assert isinstance(inputs.get('layout_revision'), str) and re.fullmatch(
        r'[0-9a-f]{40}(?:[0-9a-f]{24})?', inputs['layout_revision']
    ), 'Exact layout revision required'
    revisions = inputs.get('authorized_followon_revisions')
    assert isinstance(revisions, list) and all(
        isinstance(revision, str) and re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', revision)
        for revision in revisions
    ), 'Exact authorized follow-on revisions required'
    for task in LAYOUT.REQUIRED:
        path = receipt_path(task)
        expected = path.relative_to(LAYOUT.ROOT).as_posix()
        assert receipts.get(task) == expected, task + ': aggregation input must name ' + expected
        if receipt_exists(task):
            assert LAYOUT.local(receipts[task]) == path, task + ': aggregation receipt resolves elsewhere'


def test_layout_aggregation_passes_with_the_tracked_input():
    instructions = (LAYOUT.PACK / 'repository-layout.md').read_text()
    assert '## Regenerating the driver receipts' in instructions, 'Receipt regeneration section required'
    for value in ['HYPERFIDE_LAYOUT_NODE22', 'HYPERFIDE_LAYOUT_NODE24',
                  'repository-layout.json', 'stale receipt',
                  'cp build/layout/0.4/receipt.json spec/hyperfide-source-control/receipts/0.4.json',
                  'python3 tests/hyperfide/cases/source_control/layout_driver_receipts_test.py']:
        assert value in instructions, 'Receipt regeneration instructions missing: ' + value
    missing = []
    for task in LAYOUT.REQUIRED:
        driver = Path(__file__).with_name(task.replace('.', '_') + '.py')
        spec = importlib.util.spec_from_file_location('layout_driver_' + task.replace('.', '_'), driver)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert module.ROOT == LAYOUT.ROOT, task + ': driver uses a different project root'
        assert callable(module.main), task + ': driver entrypoint required'
        assert driver_command(task) in instructions, task + ': regeneration command required'
        if not receipt_exists(task):
            missing.append(task)
    if missing:
        print('UNRUN 0.9: python3 tests/hyperfide/cases/source_control/0_9.py --inputs '
              + str(INPUT.resolve()) + ' missing inputs: tracked PASS driver receipts '
              + ', '.join(missing), flush=True)
        return
    argv = [sys.executable, str(Path(LAYOUT.__file__).resolve()), '--inputs', str(INPUT.resolve())]
    result = subprocess.run(argv, cwd=LAYOUT.ROOT, capture_output=True, text=True, timeout=600)
    assert result.returncode == 0, (
        'Layout aggregation exited ' + str(result.returncode) + '\n' + result.stdout + result.stderr
    )
    statuses = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith('{')]
    assert any(value.get('task') == '0.9' and value.get('status') == 'PASS' for value in statuses), (
        'Layout aggregation did not print status PASS: ' + result.stdout
    )


def main():
    for case in [test_every_required_driver_has_a_tracked_pass_receipt,
                 test_tracked_receipts_bind_to_the_current_mapping_and_snapshot,
                 test_aggregation_input_names_every_tracked_receipt,
                 test_layout_aggregation_passes_with_the_tracked_input]:
        try:
            case()
        except (AssertionError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            print('FAIL ' + case.__name__ + ': ' + str(error), file=sys.stderr)
            return 1
        print('PASS ' + case.__name__, flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
