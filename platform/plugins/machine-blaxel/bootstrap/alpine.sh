#!/bin/sh
set -eu
missing=""
command -v git >/dev/null 2>&1 || missing="$missing git"
command -v python3 >/dev/null 2>&1 || missing="$missing python3"
for tool in make gcc g++; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing="$missing build-base"
    break
  fi
done
if [ -n "$missing" ]; then
  if ! command -v apk >/dev/null 2>&1 || [ "$(id -u)" != 0 ]; then
    echo 'Hyperfide bootstrap requires git, build-base and python3; apk installation is not allowed' >&2
    exit 1
  fi
  apk add --no-cache $missing
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo 'Hyperfide bootstrap requires an image with Node 24 present' >&2
  exit 1
fi
