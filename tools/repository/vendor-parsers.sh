#!/usr/bin/env sh
# Offline provenance and completeness check for the embedded parser sources.
set -eu
cd "$(dirname "$0")/../.."

runtime=vendor/tree-sitter
revision=a467ea8502d95562171f97953a6dc5b2a8622609
runtime_manifest_sha256=89b4145db975a3555cc9668fac0354dee8e07dd10490c8447eb2cf3bf0a5f12e
parsers_manifest_sha256=b1c5414436116b414cea294402c9b7b3ab7695a1ceaaad1de8cda7a41188b7c1

# REVISION is provenance metadata, not a content check.  Keep a checked-in
# sha256 manifest for every vendored input and verify both the exact file set
# and every byte before compiling it.  This catches a modified parser even if
# somebody leaves the marker untouched (and catches additions/removals too).
verify_manifest() {
    root=$1
    manifest=$2
    test -s "$manifest"
    actual=$(mktemp)
    trap 'rm -f "$actual"' EXIT HUP INT TERM
    (cd "$root" && find . -type f ! -name CONTENTS.sha256 -print0 |
        LC_ALL=C sort -z | xargs -0 sha256sum |
        sed 's#  \./#  #') > "$actual"
    diff -u "$manifest" "$actual" >/dev/null || {
        echo "vendored content manifest mismatch: $root" >&2
        diff -u "$manifest" "$actual" >&2 || true
        exit 1
    }
    (cd "$root" && sha256sum --check --strict CONTENTS.sha256 >/dev/null)
    rm -f "$actual"
    trap - EXIT HUP INT TERM
}

test "$(sha256sum "$runtime/CONTENTS.sha256" | cut -d' ' -f1)" = "$runtime_manifest_sha256"
verify_manifest "$runtime" "$runtime/CONTENTS.sha256"
test "$(cat "$runtime/REVISION")" = "$revision"
test -s "$runtime/LICENSE"
test -s "$runtime/lib/src/unicode/LICENSE"
test -s "$runtime/lib/src/lib.c"
test -s "$runtime/lib/include/tree_sitter/api.h"
test -s "$runtime/lib/include/tree_sitter/parser.h"

if [ -d vendor/parsers ]; then
    # Grammar families may share one licence and provenance manifest across
    # several generated sources. Walk to the family root without leaving it.
    find vendor/parsers -type f -name parser.c -print | sort | while IFS= read -r parser; do
        family=$(printf '%s\n' "$parser" | cut -d/ -f1-3)
        dir=$(dirname "$parser")
        licence=0 provenance=0 revision_found=0
        while :; do
            for name in LICENSE LICENCE LICENSE.md; do
                test ! -s "$dir/$name" || licence=1
            done
            for name in REVISION PROVENANCE MANIFEST.kvx MANIFEST.md \
                        manifest.tsv GRAMMARS.kvx; do
                if test -s "$dir/$name"; then
                    provenance=1
                    grep -Eiq '(^|[^0-9a-f])[0-9a-f]{40}([^0-9a-f]|$)' "$dir/$name" && revision_found=1 || true
                fi
            done
            test "$dir" != "$family" || break
            dir=$(dirname "$dir")
        done
        test "$licence" -eq 1 || {
            echo "missing grammar licence: $parser" >&2
            exit 1
        }
        test "$provenance" -eq 1 || {
            echo "missing grammar revision: $parser" >&2
            exit 1
        }
        test "$revision_found" -eq 1 || {
            echo "grammar provenance has no immutable source revision: $parser" >&2
            exit 1
        }
    done
fi
test "$(sha256sum vendor/parsers/CONTENTS.sha256 | cut -d' ' -f1)" = "$parsers_manifest_sha256"
verify_manifest vendor/parsers vendor/parsers/CONTENTS.sha256
echo "vendored parser provenance: ok"
