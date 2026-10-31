#!/bin/sh
# Compatibility shim for integrations requiring a script. Never consult PATH.
set -eu
dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
target="$dir/hyperfide"
if [ ! -f "$target" ] || [ ! -x "$target" ]; then
  if [ -f "$dir/../../Makefile" ]; then
    target="$dir/../../hyperfide"
  else
    target="$dir/../bin/hyperfide"
  fi
fi
[ -f "$target" ] && [ -x "$target" ] || { echo "hyperfide: canonical executable is missing beside this entrypoint" >&2; exit 127; }
[ ! "$target" -ef "$0" ] || { echo "hyperfide: recursive compatibility entrypoint refused" >&2; exit 126; }
exec "$target" "$@"
