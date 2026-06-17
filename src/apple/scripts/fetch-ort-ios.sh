#!/usr/bin/env bash
# fetch-ort-ios.sh — Extract and verify the vendored ONNX Runtime iOS
# static xcframework (M6 of epic #1234, issue #1244; vendored in #1353).
#
# The ORT iOS static xcframework zip is committed to the repo at
# src/apple/vendor/ort-ios/pod-archive-onnxruntime-c-<version>.zip
# (45 MB — under GitHub's per-file limit, so no Git LFS needed).
# This script copies it to the local cache at ~/.cache/maple-pano/ort-ios/,
# verifies the SHA-256, and extracts it. No network access is required or
# attempted. The build script (build-xcframework.sh) calls this as a
# pre-step for the iOS/iOS-sim cargo invocations.
#
# Run standalone before building:
#   ./src/apple/scripts/fetch-ort-ios.sh
#
# The cached archive is reused on subsequent calls. Pass --force to
# re-extract from the vendored zip even when the archive is already present.
#
# Reproducibility anchors (update together with src/apple/vendor/ort-ios/
# if the ORT version is bumped):
#   ORT version:   1.22.0
#   ort crate:     2.0.0-rc.10  (pins ORT 1.22.x C API)
#   Vendored zip:  src/apple/vendor/ort-ios/pod-archive-onnxruntime-c-1.22.0.zip
#   Upstream URL:  https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.22.0.zip
#                  (for version-bump provenance only — NOT fetched at build time)
#   ZIP SHA-256:   90d9de5a139087a6b05a18125d01d01d198820e1731e6f0f11b38749b2ab181f
#
# The extracted layout under ORT_IOS_XCFW_DIR:
#   onnxruntime-c-1.22.0/
#     onnxruntime.xcframework/
#       ios-arm64/onnxruntime.framework/onnxruntime          ← arm64 static (.a)
#       ios-arm64_x86_64-simulator/onnxruntime.framework/    ← fat static (.a)
#       macos-arm64_x86_64/onnxruntime.framework/            ← macOS dylib (not used here)
#       Info.plist
#     Headers/           ← top-level C API headers
#     LICENSE
#
# ort-sys's build.rs recognises ORT_LIB_LOCATION and looks for a file named
# `onnxruntime` (no prefix/extension) or `libonnxruntime.a` within it. The
# framework binary IS named `onnxruntime` — a Mach-O static archive — so
# passing the framework directory directly works without a symlink.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORT_VERSION="1.22.0"
ORT_ZIP_SHA256="90d9de5a139087a6b05a18125d01d01d198820e1731e6f0f11b38749b2ab181f"

# Source of truth: the vendored zip committed in the repo.
VENDORED_ZIP="${SCRIPT_DIR}/../vendor/ort-ios/pod-archive-onnxruntime-c-${ORT_VERSION}.zip"

CACHE_DIR="${HOME}/.cache/maple-pano/ort-ios"
ARCHIVE="${CACHE_DIR}/pod-archive-onnxruntime-c-${ORT_VERSION}.zip"
EXTRACTED="${CACHE_DIR}/onnxruntime-c-${ORT_VERSION}"

# Sentinel: the arm64 static lib (proves extraction completed).
ARM64_LIB="${EXTRACTED}/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
FORCE=0
for arg in "$@"; do
    [[ "$arg" == "--force" ]] && FORCE=1
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
verify_sha256() {
    local file="$1"
    local expected="$2"
    local actual
    if command -v shasum &>/dev/null; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    elif command -v sha256sum &>/dev/null; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        echo "ERROR: neither shasum nor sha256sum found — cannot verify $file" >&2
        exit 1
    fi
    if [[ "$actual" != "$expected" ]]; then
        echo "ERROR: SHA-256 mismatch for $file" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        echo "The vendored zip at src/apple/vendor/ort-ios/ may be corrupted." >&2
        exit 1
    fi
    echo "    SHA-256 OK: $actual"
}

# ---------------------------------------------------------------------------
# 1. Create cache dir
# ---------------------------------------------------------------------------
mkdir -p "$CACHE_DIR"

# ---------------------------------------------------------------------------
# 2. Copy from vendored zip (skip when archive is present + verified,
#    unless --force). There is no network fallback — the repo is the source
#    of truth.
# ---------------------------------------------------------------------------
if [[ "$FORCE" -eq 1 ]]; then
    echo "==> --force: removing cached archive and extraction"
    rm -f "$ARCHIVE"
    rm -rf "$EXTRACTED"
fi

if [[ -f "$ARCHIVE" ]]; then
    echo "==> Cached archive found — verifying SHA-256..."
    verify_sha256 "$ARCHIVE" "$ORT_ZIP_SHA256"
    echo "    Archive is current — skipping copy."
else
    if [[ ! -f "$VENDORED_ZIP" ]]; then
        echo "ERROR: vendored zip not found: $VENDORED_ZIP" >&2
        echo "       The repo is the source of truth for this artifact." >&2
        echo "       Check that src/apple/vendor/ort-ios/ is present and the repo is" >&2
        echo "       fully checked out (no partial sparse-checkout)." >&2
        echo "       Upstream URL (for version-bump reference, do NOT fetch at build time):" >&2
        echo "         https://download.onnxruntime.ai/pod-archive-onnxruntime-c-${ORT_VERSION}.zip" >&2
        exit 1
    fi
    echo "==> Copying vendored ONNX Runtime iOS static xcframework v${ORT_VERSION}..."
    echo "    Source:      $VENDORED_ZIP"
    echo "    Destination: $ARCHIVE"
    cp "$VENDORED_ZIP" "$ARCHIVE"
    echo "==> Verifying SHA-256..."
    verify_sha256 "$ARCHIVE" "$ORT_ZIP_SHA256"
fi

# ---------------------------------------------------------------------------
# 3. Extract (skip when the sentinel lib is already present)
# ---------------------------------------------------------------------------
if [[ -f "$ARM64_LIB" ]]; then
    echo "==> Already extracted — skipping."
else
    echo "==> Extracting..."
    # The zip's internal layout is FLAT — `Headers/`, `LICENSE`,
    # `onnxruntime.xcframework/` at the root, no `onnxruntime-c-<version>/`
    # wrapping directory. The sentinel path nests under `$EXTRACTED` which
    # IS that wrapping, so we have to extract INTO `$EXTRACTED` (creating
    # the wrapping ourselves) rather than into `$CACHE_DIR` (which would
    # land the files one level too shallow). Without this, a fresh Xcode
    # Cloud worker — no pre-existing cache — extracts to `$CACHE_DIR` and
    # the sentinel check fails with `extraction completed but sentinel not
    # found`. Worked locally only because a prior manual setup had already
    # moved files under the wrapping. (CI failure spotted on PR #1245
    # post-merge.)
    mkdir -p "$EXTRACTED"
    unzip -q -o "$ARCHIVE" -d "$EXTRACTED"
    if [[ ! -f "$ARM64_LIB" ]]; then
        echo "ERROR: extraction completed but sentinel not found: $ARM64_LIB" >&2
        exit 1
    fi
    echo "    Extracted to $EXTRACTED"
fi

# ---------------------------------------------------------------------------
# 4. Verify the static libs are Mach-O archives
# ---------------------------------------------------------------------------
SIM_LIB="${EXTRACTED}/onnxruntime.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework/onnxruntime"
for lib in "$ARM64_LIB" "$SIM_LIB"; do
    if ! file "$lib" | grep -q "ar archive"; then
        echo "ERROR: $lib is not a static archive (file reports: $(file "$lib"))" >&2
        exit 1
    fi
done
echo "==> iOS arm64 static lib:          $ARM64_LIB"
echo "    iOS arm64_x86_64-sim static lib: $SIM_LIB"
echo ""
echo "==> fetch-ort-ios.sh done."
echo ""
echo "    To use in the xcframework build, the build script sets:"
echo "      ORT_IOS_XCFW_DIR=${EXTRACTED}/onnxruntime.xcframework"
