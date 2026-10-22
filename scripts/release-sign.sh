#!/usr/bin/env bash
# Detached Ed25519 signature for one release output file (release.json), made with the
# same protected key release.sh uses for manifest.sig. Writes FILE.sig after verifying it.
# --check-key runs only the key gate; release.sh calls it before the build so an absent,
# unprotected or non-Ed25519 key refuses before make runs.
# Usage: scripts/release-sign.sh KEY_FILE FILE | scripts/release-sign.sh --check-key KEY_FILE
set -euo pipefail
die(){ echo "hyperfide release: $*" >&2; exit 2; }
check_only=0
if [ "$#" -eq 2 ] && [ "$1" = "--check-key" ]; then check_only=1; key="$2"
elif [ "$#" -eq 2 ]; then key="$1"; file="$2"
else die "usage: scripts/release-sign.sh KEY_FILE FILE | --check-key KEY_FILE"; fi
openssl=/usr/bin/openssl
case "$key" in /*) ;; *) die "signing key must be an absolute private reference" ;; esac
[ -e "$key" ] || [ -L "$key" ] || die "signing key file $key does not exist"
[ -f "$key" ] && [ ! -L "$key" ] || die "signing key must be a regular file"
[ "$(stat -c %u "$key")" = "$(id -u)" ] && [ $(( 0$(stat -c %a "$key") & 077 )) -eq 0 ] && [ "$(stat -c %s "$key")" -le 16384 ] || die "signing key must be a protected owner file"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
"$openssl" pkey -in "$key" -pubout -outform DER -out "$work/public.der" </dev/null 2>/dev/null || die "configured signing key must be Ed25519"
[ "$(stat -c %s "$work/public.der")" -eq 44 ] && [ "$(head -c 12 "$work/public.der" | od -An -tx1 | tr -d ' \n')" = "302a300506032b6570032100" ] || die "configured signing key must be Ed25519"
if [ "$check_only" -eq 1 ]; then echo "sha256:$(sha256sum "$work/public.der" | cut -d' ' -f1)"; exit 0; fi
[ -f "$file" ] && [ ! -L "$file" ] || die "file to sign is missing"
"$openssl" pkeyutl -sign -inkey "$key" -rawin -in "$file" -out "$work/signature" </dev/null 2>/dev/null || die "signing failed"
[ "$(stat -c %s "$work/signature")" -eq 64 ] || die "signing failed"
"$openssl" pkeyutl -verify -pubin -keyform DER -inkey "$work/public.der" -rawin -in "$file" -sigfile "$work/signature" </dev/null >/dev/null 2>&1 || die "signature does not verify"
install -m 0644 "$work/signature" "$file.sig"
echo "sha256:$(sha256sum "$work/public.der" | cut -d' ' -f1)"
