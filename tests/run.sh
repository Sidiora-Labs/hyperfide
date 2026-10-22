#!/usr/bin/env bash
# Codify integration test runner. Usage: CG=/path/to/cg tests/run.sh
#
# Skip contract: a test whose prerequisites are absent exits 77 and prints a
# line "SKIP: <reason>". It is reported as SKIP with that reason and never
# counted as PASS. Exit 77 without a reason line is a FAIL, so a skip is
# always explained.
set -u
cd "$(dirname "$0")"
: "${CG:=$(cd .. && pwd)/cg}"
export CG

if [ ! -x "$CG" ]; then
    echo "tests/run.sh: CG binary not found at $CG (run make first)" >&2
    exit 1
fi

pass=0 fail=0 skip=0
log="$(mktemp)"
for t in integration/[0-9]*.sh; do
    name="$(basename "$t")"
    bash "$t" >"$log" 2>&1
    rc=$?
    reason="$(sed -n 's/^SKIP: *//p' "$log" | tail -n 1)"
    if [ "$rc" -eq 0 ]; then
        echo "PASS $name"
        pass=$((pass + 1))
    elif [ "$rc" -eq 77 ] && [ -n "$reason" ]; then
        echo "SKIP $name: $reason"
        skip=$((skip + 1))
    else
        if [ "$rc" -eq 77 ]; then
            echo "FAIL $name (exit 77 without a SKIP: reason line)"
        else
            echo "FAIL $name"
        fi
        sed 's/^/     /' "$log"
        fail=$((fail + 1))
    fi
done
rm -f "$log"
echo "integration: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
