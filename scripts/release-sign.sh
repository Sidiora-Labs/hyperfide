#!/usr/bin/env bash
# Detached Ed25519 signature for one release output file (release.json), made with the
# same protected key release.sh uses for manifest.sig. Writes FILE.sig after verifying it.
# Usage: scripts/release-sign.sh KEY_FILE FILE
set -euo pipefail
die(){ echo "hyperfide release: $*" >&2; exit 2; }
[ "$#" -eq 2 ] || die "usage: scripts/release-sign.sh KEY_FILE FILE"
key="$1"; file="$2"; openssl=/usr/bin/openssl
case "$key" in /*) ;; *) die "signing key must be an absolute private reference" ;; esac
[ -f "$key" ] && [ ! -L "$key" ] || die "signing key must be a regular file"
[ "$(stat -c %u "$key")" = "$(id -u)" ] && [ $(( 0$(stat -c %a "$key") & 077 )) -eq 0 ] && [ "$(stat -c %s "$key")" -le 16384 ] || die "signing key must be a protected owner file"
[ -f "$file" ] && [ ! -L "$file" ] || die "file to sign is missing"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
"$openssl" pkey -in "$key" -pubout -outform DER -out "$work/public.der" </dev/null 2>/dev/null || die "configured signing key must be Ed25519"
[ "$(stat -c %s "$work/public.der")" -eq 44 ] && [ "$(head -c 12 "$work/public.der" | od -An -tx1 | tr -d ' \n')" = "302a300506032b6570032100" ] || die "configured signing key must be Ed25519"
"$openssl" pkeyutl -sign -inkey "$key" -rawin -in "$file" -out "$work/signature" </dev/null 2>/dev/null || die "signing failed"
[ "$(stat -c %s "$work/signature")" -eq 64 ] || die "signing failed"
"$openssl" pkeyutl -verify -pubin -keyform DER -inkey "$work/public.der" -rawin -in "$file" -sigfile "$work/signature" </dev/null >/dev/null 2>&1 || die "signature does not verify"
install -m 0644 "$work/signature" "$file.sig"
echo "sha256:$(sha256sum "$work/public.der" | cut -d' ' -f1)"
