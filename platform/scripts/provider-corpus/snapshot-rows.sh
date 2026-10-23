#!/usr/bin/env bash
# Run the provider-corpus gates (row snapshots + timeline perf baseline).
#
#   scripts/provider-corpus/snapshot-rows.sh compare   # default: fail on any
#                                                      # diff not in allowlist
#   scripts/provider-corpus/snapshot-rows.sh write     # mint a new baseline
#
# Requires HYPERFIDE_PROVIDER_CORPUS_DIR (defaults to ~/.hyperfide/provider-corpus when that
# directory exists). See docs/debugging-and-qa.md, "Provider corpus".
#
# snapshots/rows is the baseline minted on main and shared by every
# workstream. From a feature branch, compare against it with a per-workstream
# allowlist and never write into it:
#
#   HYPERFIDE_PROVIDER_CORPUS_ALLOWLIST=apps/server/test/provider-corpus/allowlists/<ws>.json \
#     scripts/provider-corpus/snapshot-rows.sh compare
#   HYPERFIDE_PROVIDER_CORPUS_SNAPSHOT_DIR=$HOME/.hyperfide/provider-corpus/snapshots/rows.<ws> \
#     scripts/provider-corpus/snapshot-rows.sh write      # shadow snapshot
#   HYPERFIDE_PROVIDER_CORPUS_ROW_CLASSES=apps/server/test/provider-corpus/allowlists/<ws>-row-classes.json \
#     scripts/provider-corpus/snapshot-rows.sh compare    # identity-based classes
#                                                         # (rows added/removed/moved)
set -euo pipefail

mode="${1:-compare}"
case "${mode}" in
  write|compare) ;;
  *)
    echo "usage: $0 [write|compare]" >&2
    exit 2
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/../.." && pwd -P)"

if [[ -z "${HYPERFIDE_PROVIDER_CORPUS_DIR:-}" && -f "${HOME}/.hyperfide/provider-corpus/manifest.json" ]]; then
  export HYPERFIDE_PROVIDER_CORPUS_DIR="${HOME}/.hyperfide/provider-corpus"
fi
if [[ -z "${HYPERFIDE_PROVIDER_CORPUS_DIR:-}" || ! -f "${HYPERFIDE_PROVIDER_CORPUS_DIR}/manifest.json" ]]; then
  echo "HYPERFIDE_PROVIDER_CORPUS_DIR must point at a corpus directory with manifest.json" >&2
  exit 2
fi

export HYPERFIDE_PROVIDER_CORPUS_SNAPSHOT="${mode}"
cd "${repo_root}"
pnpm exec turbo run test:provider-corpus --filter=@hyperfide/server

snapshots_dir="${HYPERFIDE_PROVIDER_CORPUS_DIR}/snapshots"
if [[ -f "${snapshots_dir}/rows-last-run.json" ]]; then
  echo
  echo "Row snapshots: ${snapshots_dir}/rows-last-run.json"
  cat "${snapshots_dir}/rows-last-run.json"
fi
if [[ -f "${snapshots_dir}/perf-last-run.md" ]]; then
  echo
  echo "Timeline perf: ${snapshots_dir}/perf-last-run.md"
  cat "${snapshots_dir}/perf-last-run.md"
fi
