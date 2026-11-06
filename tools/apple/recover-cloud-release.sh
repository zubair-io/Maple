#!/bin/bash
# Re-export the exact production archive using existing signing assets (#5681).
set -euo pipefail
umask 077
: "${RELEASE_TAG:?}" "${RUNNER_TEMP:?}"
: "${MACOS_CERT_P12_BASE64:?}" "${MACOS_CERT_PASSWORD:?}"
: "${MACOS_PROVISIONING_PROFILES_BASE64:?}" "${APPLE_TEAM_ID:?}"
: "${AC_PRIVATE_KEY:?}" "${AC_KEY_ID:?}" "${AC_ISSUER_ID:?}"
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || exit 1
ROOT="$(git rev-parse --show-toplevel)"
EXPECTED_COMMIT="$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")"
export EXPECTED_COMMIT
WORK="$(mktemp -d "$RUNNER_TEMP/mac-recovery.XXXXXX")"
KEYCHAIN="$WORK/signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
export AC_KEY_PATH="$WORK/AuthKey.p8"
security list-keychains -d user >"$WORK/keychains.before"
cleanup() {
	# Only our temporary keychain is removed. Preserve the runner's search list.
	xargs security list-keychains -d user -s <"$WORK/keychains.before"
	security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT
printf '%s' "$AC_PRIVATE_KEY" >"$AC_KEY_PATH"
ruby "$ROOT/tools/apple/download-cloud-archive.rb" "$WORK/archive.zip"
ditto -x -k "$WORK/archive.zip" "$WORK/archive"
ARCHIVE="$(find "$WORK/archive" -maxdepth 2 -name '*.xcarchive' -type d)"
[ -d "$ARCHIVE" ] || {
	echo 'Expected one xcarchive'
	exit 1
}

printf '%s' "$MACOS_CERT_P12_BASE64" | openssl base64 -d -A >"$WORK/cert.p12"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 7200 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
xargs security list-keychains -d user -s "$KEYCHAIN" <"$WORK/keychains.before"
rm "$WORK/cert.p12"

printf '%s' "$MACOS_PROVISIONING_PROFILES_BASE64" | openssl base64 -d -A >"$WORK/profiles.tar.gz"
mkdir "$WORK/profiles"
tar xzf "$WORK/profiles.tar.gz" -C "$WORK/profiles"
export RECOVERY_WORK="$WORK"
python3 - <<'PY'
import datetime, os, pathlib, plistlib, shutil, subprocess
work = pathlib.Path(os.environ['RECOVERY_WORK'])
team = os.environ['APPLE_TEAM_ID']
profiles = {}
for path in (work / 'profiles').rglob('*.provisionprofile'):
    decoded = subprocess.check_output(['openssl', 'cms', '-verify', '-inform', 'DER',
                                      '-noverify', '-binary', '-in', str(path)], stderr=subprocess.DEVNULL)
    profile = plistlib.loads(decoded)
    if profile['ExpirationDate'] <= datetime.datetime.utcnow():
        raise ValueError('Expired provisioning profile')
    if team not in profile['TeamIdentifier']:
        raise ValueError('Provisioning profile belongs to another team')
    entitlements = profile['Entitlements']
    app_id = entitlements['com.apple.application-identifier']
    bundle = app_id.removeprefix(team + '.')
    if bundle in profiles:
        raise ValueError('Duplicate provisioning profile for ' + bundle)
    profiles[bundle] = profile['UUID']
    for directory in ('Library/MobileDevice/Provisioning Profiles',
                      'Library/Developer/Xcode/UserData/Provisioning Profiles'):
        destination = pathlib.Path.home() / directory
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination / (profile['UUID'] + '.provisionprofile'))
expected = {'app.justmaple.aperture' + suffix for suffix in ('', '.FileProvider', '.QuickLook', '.Widget')}
if set(profiles) != expected:
    raise ValueError('Expected profiles for Maple and its three extensions')
with (work / 'export.plist').open('wb') as output:
    plistlib.dump({'method': 'developer-id', 'teamID': team, 'signingStyle': 'manual',
                  'signingCertificate': 'Developer ID Application',
                  'provisioningProfiles': profiles, 'destination': 'export'}, output)
PY
# Manual export cannot fall back to the broken cloud-managed certificate.
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
	-exportOptionsPlist "$WORK/export.plist" -exportPath "$WORK/export"
export CI_XCODEBUILD_ACTION=archive CI_XCODEBUILD_EXIT_CODE=0
export CI_ARCHIVE_PATH="$ARCHIVE" CI_COMMIT="$EXPECTED_COMMIT" CI_TAG="$RELEASE_TAG"
export CI_DEVELOPER_ID_SIGNED_APP_PATH="$WORK/export"
export MAC_RELEASE_OUTPUT_DIR="$RUNNER_TEMP/mac-release-output"
bash "$ROOT/src/apple/ci_scripts/ci_post_xcodebuild.sh"
