#!/usr/bin/env python3
"""Qualification through real lanes, receipts, checker and wave publication."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'support'))
from platform_fixture import QualificationFixture


def main():
    with QualificationFixture() as platform:
        platform.implement()
        assert 'status = "implemented"' in platform.spec.read_text()
        result = platform.qualification()
        assert result['receipt']['task'] == '1.1'
        assert result['lane']['state'] == 'passed'
        assert result['checker']['status'] == 'pass'
        assert result['publication']['pushed'] is True
        assert result['closure']['closed'] == ['1.1']
        print('closure_check ' + json.dumps(result['closure'], sort_keys=True))
        print('PASS qualification: implemented, lane, checker, receipt, wave, permission Ask, local squash push')


if __name__ == '__main__':
    main()
