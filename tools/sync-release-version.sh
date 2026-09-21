#!/usr/bin/env bash
# sync-release-version.sh — bring every committed version field in line with a
# requested release (#3486, #3825). The version-sync workflow runs this before
# tagging so the reviewed source, generated distribution, and release artifacts
# all carry the same version. A developer can also run it by hand.
#
# Usage:
#   tools/sync-release-version.sh 0.0.5      # or v0.0.5
#
# Touches:
#   src/maple/package.json + src/maple/npm/*/package.json  (via sync-versions.ts)
#   src/maple/src/version.ts  MAPLE_VERSION constant        (via sync-versions.ts)
#   src/apple/Maple.xcodeproj/project.pbxproj              (every MARKETING_VERSION)

set -euo pipefail

VERSION="${1:-}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "Usage: $0 <semver>   (got '${1:-}')" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bun "$ROOT/src/maple/scripts/sync-versions.ts" "$VERSION"

# Every target (app, embedded extensions, Maple TV) carries the product
# version: Apple requires an embedded extension's CFBundleShortVersionString
# to match its containing app, and the archive step stamps them all the same
# way (release.yml). sed -E keeps the file's tab indentation intact.
PBXPROJ="$ROOT/src/apple/Maple.xcodeproj/project.pbxproj"
sed -E -i.bak "s/(MARKETING_VERSION = )[^;]+;/\1${VERSION};/" "$PBXPROJ"
rm -f "$PBXPROJ.bak"
echo "Set MARKETING_VERSION = ${VERSION} in $(grep -c "MARKETING_VERSION = ${VERSION};" "$PBXPROJ") build configurations"
