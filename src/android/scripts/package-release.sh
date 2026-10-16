#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${MAPLE_VERSION_CODE:?A unique distribution workflow run number is required}"
: "${ANDROID_UPLOAD_KEYSTORE_BASE64:?The encrypted upload keystore is required}"
: "${ANDROID_UPLOAD_STORE_PASSWORD:?The keystore password is required}"
: "${ANDROID_UPLOAD_KEY_ALIAS:?The upload alias is required}"
: "${ANDROID_UPLOAD_KEY_PASSWORD:?The upload key password is required}"
signing_dir=$(mktemp -d)
trap 'rm -f "$signing_dir/upload.p12" "$signing_dir/upload.der"; rmdir "$signing_dir"' EXIT
chmod 700 "$signing_dir"
export ANDROID_UPLOAD_KEYSTORE="$signing_dir/upload.p12"
python3 - <<'PY'
import base64, os
from pathlib import Path
key = Path(os.environ['ANDROID_UPLOAD_KEYSTORE'])
key.write_bytes(base64.b64decode(os.environ['ANDROID_UPLOAD_KEYSTORE_BASE64'], validate=True))
key.chmod(0o600)
PY
unset ANDROID_UPLOAD_KEYSTORE_BASE64
keytool -exportcert -keystore "$ANDROID_UPLOAD_KEYSTORE" \
	-alias "$ANDROID_UPLOAD_KEY_ALIAS" -storepass:env ANDROID_UPLOAD_STORE_PASSWORD \
	-file "$signing_dir/upload.der"
expected=$(openssl x509 -in signing/maple-upload.pem -outform DER | openssl dgst -sha256)
actual=$(openssl dgst -sha256 <"$signing_dir/upload.der")
test "${expected##* }" = "${actual##* }"
./gradlew --no-daemon -PmapleVersionCode="$MAPLE_VERSION_CODE" \
	-PmapleAbis=arm64-v8a,x86_64 assembleRelease bundleRelease lintRelease
sdk="${ANDROID_HOME:?ANDROID_HOME is required}"
apk=app/build/outputs/apk/release/app-release.apk
aab=app/build/outputs/bundle/release/app-release.aab
apk_signature=$("$sdk/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$apk")
echo "$apk_signature"
grep -Fq "Signer #1 certificate SHA-256 digest: ${actual##* }" <<<"$apk_signature"
jarsigner -verify "$aab"
bundle_signature=$(keytool -printcert -jarfile "$aab" -rfc | openssl x509 -outform DER | openssl dgst -sha256)
test "${expected##* }" = "${bundle_signature##* }"
version=$(python3 -c 'import json; print(json.load(open("../maple/package.json"))["version"])')
"$sdk/build-tools/36.0.0/aapt" dump badging "$apk" |
	grep -F "package: name='app.justmaple.aperture' versionCode='$MAPLE_VERSION_CODE' versionName='$version'"
mkdir -p out
cp "$apk" "out/Maple-Android-$version.apk"
cp "$aab" "out/Maple-Android-$version.aab"
cp signing/maple-upload.pem out/Maple-Android-upload-certificate.pem
python3 - <<'PY'
import hashlib
from pathlib import Path
from zipfile import ZipFile
for artifact, prefix in (('app/build/outputs/apk/release/app-release.apk', 'lib/'),
                         ('app/build/outputs/bundle/release/app-release.aab', 'base/lib/')):
    with ZipFile(artifact) as archive:
        for abi in ('arm64-v8a', 'x86_64'):
            assert f'{prefix}{abi}/libmaple_jni.so' in archive.namelist(), f'Missing native ABI {abi}'
out = Path('out')
lines = []
for path in sorted(out.iterdir()):
    if path.suffix in ('.apk', '.aab', '.pem'):
        with path.open('rb') as stream:
            lines.append(f'{hashlib.file_digest(stream, "sha256").hexdigest()}  {path.name}\n')
(out / 'Maple-Android-SHA256SUMS.txt').write_text(''.join(lines))
PY
