#!/bin/bash
# Publish the direct-download Mac release from the same Xcode Cloud archive
# used for TestFlight and the App Store. Xcode Cloud performs the one compile;
# this script only notarizes and packages its Developer ID export.

set -euo pipefail

if [ "${CI_XCODEBUILD_ACTION:-}" != "archive" ] || [ -z "${CI_TAG:-}" ]; then
	echo "==> Not a tag-triggered archive; skipping direct Mac distribution"
	exit 0
fi

if [ "${CI_XCODEBUILD_EXIT_CODE:-1}" != "0" ]; then
	echo "==> Archive failed; skipping direct Mac distribution"
	exit 0
fi

for variable in CI_ARCHIVE_PATH CI_COMMIT; do
	if [ -z "${!variable:-}" ]; then
		echo "ERROR: missing Xcode Cloud environment variable: $variable" >&2
		exit 1
	fi
done

ARCHIVE_INFO="$CI_ARCHIVE_PATH/Info.plist"
ARCHIVE_PLATFORM="$(/usr/libexec/PlistBuddy \
	-c 'Print :ApplicationProperties:CFBundleSupportedPlatforms:0' \
	"$ARCHIVE_INFO" 2>/dev/null || true)"
if [ "$ARCHIVE_PLATFORM" != "MacOSX" ]; then
	echo "==> Archive platform is ${ARCHIVE_PLATFORM:-unknown}, not macOS; skipping direct Mac distribution"
	exit 0
fi

required=(
	CI_DEVELOPER_ID_SIGNED_APP_PATH
	GITHUB_TOKEN
	AC_KEY_ID
	AC_ISSUER_ID
	AC_PRIVATE_KEY
)
missing=()
for variable in "${required[@]}"; do
	if [ -z "${!variable:-}" ]; then
		missing+=("$variable")
	fi
done
if [ "${#missing[@]}" -ne 0 ]; then
	printf 'ERROR: missing Xcode Cloud environment variable(s): %s\n' "${missing[*]}" >&2
	echo "CI_DEVELOPER_ID_SIGNED_APP_PATH requires the workflow's macOS archive to include Direct Distribution/notarization." >&2
	exit 1
fi

if ! [[ "$CI_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
	echo "ERROR: release tag must look like v1.2.3 or v1.2.3-rc.1 (got '$CI_TAG')" >&2
	exit 1
fi

retry() {
	local attempt=1
	local maximum=5
	local delay=5
	while ! "$@"; do
		if [ "$attempt" -ge "$maximum" ]; then
			echo "ERROR: '$*' failed after $maximum attempts" >&2
			return 1
		fi
		echo "==> attempt $attempt/$maximum failed; retrying in ${delay}s" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maple-release.XXXXXX")"
NOTARY_KEY="$WORK_DIR/AuthKey_${AC_KEY_ID}.p8"

cleanup() {
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "==> Resolving the Developer ID export from the production archive"
if [ -d "$CI_DEVELOPER_ID_SIGNED_APP_PATH" ] &&
	[[ "$CI_DEVELOPER_ID_SIGNED_APP_PATH" == *.app ]]; then
	SOURCE_APP="$CI_DEVELOPER_ID_SIGNED_APP_PATH"
else
	SOURCE_APP="$(find "$CI_DEVELOPER_ID_SIGNED_APP_PATH" -maxdepth 4 -type d -name '*.app' -print -quit)"
fi
if [ -z "${SOURCE_APP:-}" ]; then
	echo "ERROR: no app bundle found under CI_DEVELOPER_ID_SIGNED_APP_PATH" >&2
	exit 1
fi

APP_PATH="$WORK_DIR/Maple.app"
ditto "$SOURCE_APP" "$APP_PATH"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")"
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
EXPECTED_VERSION="${CI_TAG#v}"
if [[ "$CI_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$VERSION" != "$EXPECTED_VERSION" ]; then
	echo "ERROR: archive version $VERSION does not match tag $CI_TAG" >&2
	exit 1
fi

ARCHITECTURES="$(lipo -archs "$APP_PATH/Contents/MacOS/$EXECUTABLE")"
for architecture in arm64 x86_64; do
	if [[ " $ARCHITECTURES " != *" $architecture "* ]]; then
		echo "ERROR: production archive is not universal; missing $architecture ($ARCHITECTURES)" >&2
		exit 1
	fi
done

echo "==> Maple $VERSION ($BUILD_NUMBER), commit ${CI_COMMIT:0:12}, architectures: $ARCHITECTURES"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "==> Staging notarization credentials"
printf '%s' "$AC_PRIVATE_KEY" >"$NOTARY_KEY"
chmod 600 "$NOTARY_KEY"

echo "==> Notarizing and stapling the Developer ID app"
APP_ZIP="$WORK_DIR/Maple-notarize.zip"
ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"
xcrun notarytool submit "$APP_ZIP" \
	--key "$NOTARY_KEY" \
	--key-id "$AC_KEY_ID" \
	--issuer "$AC_ISSUER_ID" \
	--wait --timeout 2h
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

echo "==> Creating, notarizing, and stapling the distribution DMG"
DMG_STAGE="$WORK_DIR/dmg"
mkdir -p "$DMG_STAGE"
ditto "$APP_PATH" "$DMG_STAGE/Maple.app"
ln -s /Applications "$DMG_STAGE/Applications"

DMG_PATH="$WORK_DIR/Maple-macOS-$EXPECTED_VERSION.dmg"
hdiutil create -volname "Maple" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"
hdiutil verify "$DMG_PATH"
xcrun notarytool submit "$DMG_PATH" \
	--key "$NOTARY_KEY" \
	--key-id "$AC_KEY_ID" \
	--issuer "$AC_ISSUER_ID" \
	--wait --timeout 2h
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl -a -t open --context context:primary-signature -vv "$DMG_PATH"

echo "==> Uploading $(basename "$DMG_PATH") to the draft GitHub release"
export GH_TOKEN="$GITHUB_TOKEN"
REPOSITORY="${GITHUB_REPOSITORY:-zubair-io/Maple}"
if ! command -v gh >/dev/null 2>&1; then
	export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
	retry brew install gh
fi

if ! gh release view "$CI_TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
	release_args=(
		"$CI_TAG"
		--repo "$REPOSITORY"
		--draft
		--title "Maple $CI_TAG"
		--generate-notes
	)
	if [[ "$CI_TAG" == *-* ]]; then
		release_args+=(--prerelease)
	fi
	gh release create "${release_args[@]}" ||
		gh release view "$CI_TAG" --repo "$REPOSITORY" >/dev/null
fi
gh release upload "$CI_TAG" "$DMG_PATH" --repo "$REPOSITORY" --clobber

echo "==> Direct Mac release uploaded from archive $CI_ARCHIVE_PATH"
