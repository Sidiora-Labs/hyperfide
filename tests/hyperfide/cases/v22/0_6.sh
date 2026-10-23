#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 tests/hyperfide/cases/v22/identity_gate.py
node tests/hyperfide/cases/v22/0_6.mjs
