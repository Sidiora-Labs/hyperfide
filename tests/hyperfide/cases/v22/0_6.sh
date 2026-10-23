#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
brand_tmp=$(mktemp -d)
trap 'rm -rf "$brand_tmp"' EXIT
node tests/hyperfide/cases/v22/0_6.mjs --prepare "$brand_tmp/input"
node platform/tools/rename/apply.mjs --dry-run "$brand_tmp/input" > "$brand_tmp/report.json"
node tests/hyperfide/cases/v22/0_6.mjs --check "$brand_tmp/report.json"
