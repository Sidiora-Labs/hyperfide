#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

# The workspace helper runs the real ./cg docs check on the task documents.
# Preserve both failures so stale documentation cannot hide identity violations.
status=0
python3 tests/hyperfide/cases/v22/docs_check_projection.py || status=1
python3 tests/hyperfide/cases/v22/identity_gate.py || status=1
exit "$status"
