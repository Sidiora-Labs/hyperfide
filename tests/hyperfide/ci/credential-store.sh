#!/usr/bin/env bash
# Materialise a fixture credential store for the credential-store registrations
# (9.1 to 9.4) and print its configuration path. The store has no sources and no
# targets: those cases seed their own references and never read a real secret,
# so nothing here comes from a repository secret (D13).
# The layout must satisfy services/hyperfide/src/identity/credentials.ts:
# absolute non-symlinked roots owned by this uid and not group/other writable,
# and a 0600 configuration file with exactly the five keys.
# Usage: credential-store.sh <root>   (in CI: append the printed path to GITHUB_ENV)
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <root>" >&2; exit 2; }
umask 077
mkdir -p "$1"
root=$(cd "$1" && pwd -P)/credential-store
[ ! -e "$root" ] || { echo "refusing to reuse existing $root" >&2; exit 1; }
mkdir -m 700 "$root" "$root/secrets" "$root/attachments"
python3 - "$root" <<'PY'
import json, os, sys
root = sys.argv[1]
config = {"schema_version": 1, "secret_root": os.path.join(root, "secrets"),
          "attachment_root": os.path.join(root, "attachments"), "sources": [], "targets": []}
fd = os.open(os.path.join(root, "config.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as fh:
    json.dump(config, fh)
PY
printf '%s\n' "$root/config.json"
