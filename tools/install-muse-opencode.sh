#!/usr/bin/env bash
# Pinned review bootstrap (#4184), runs without the Muse key or review token.
set -euo pipefail

readonly version=1.18.34
readonly asset=opencode-linux-x64-baseline.tar.gz
readonly digest=24b0d458d21ef548b2752166303defcf7f4945b049fb4876ab78dfaf86d81b27
readonly url="https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}"
readonly destination="${1:?Pass an owned installation directory}"
readonly staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

# Retain HTTP status and curl's actual error, without printing response bodies,
# secrets, or claiming why the remote request failed.
status=0
http=$(curl --location --fail --show-error --silent --retry 2 \
	--connect-timeout 15 --max-time 180 --output "$staging/archive.tar.gz" \
	--write-out '%{http_code}' "$url") || status=$?
if ((status != 0)); then
	echo "OpenCode ${version} download failed: curl=${status}, HTTP=${http:-000}" >&2
	exit "$status"
fi
python3 - "$staging/archive.tar.gz" "$digest" <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as archive:
    digest = hashlib.file_digest(archive, 'sha256').hexdigest()
if digest != sys.argv[2]:
    raise SystemExit('OpenCode archive SHA-256 mismatch; refusing installation')
PY
mkdir -p "$destination"
tar -xzf "$staging/archive.tar.gz" -C "$staging"
test -f "$staging/opencode"
install -m 755 "$staging/opencode" "$destination/opencode"
echo "Installed checksum-verified OpenCode ${version}"
