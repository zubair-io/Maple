#!/usr/bin/env bash
# build-xcframework.sh — compile raw-ffi for Apple targets, run cbindgen,
# bundle into RawPipeline.xcframework.
#
# Usage: ./scripts/build-xcframework.sh [--release]
#
# Requirements:
#   - cargo + rustup with targets:
#       aarch64-apple-ios
#       aarch64-apple-ios-sim
#       aarch64-apple-macos (= aarch64-apple-darwin)
#       x86_64-apple-macos  (= x86_64-apple-darwin)
#   - cbindgen (cargo install cbindgen)
#   - xcodebuild (ships with Xcode)
#
# Output: src/apple/Frameworks/RawPipeline.xcframework
# and:    src/apple/Sources/MapleCore/include/RawPipeline.h

set -euo pipefail

# Xcode's "Run Script" phase launches with a minimal PATH that omits
# `~/.cargo/bin` and Homebrew, so cargo/rustc/cbindgen are not on PATH by
# default. Prepend the standard Rust toolchain location and Homebrew
# prefixes so the same script works whether invoked from a terminal
# (no-op — PATH already has these) or from Xcode.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(dirname "$SCRIPT_DIR")"
# Walk up from NATIVE_DIR to find src/raw-pipeline (works whether invoked from
# within the repo or from the repo root).
_find_raw_pipeline() {
    local dir
    for dir in \
        "$NATIVE_DIR/../raw-pipeline" \
        "$NATIVE_DIR/../../raw-pipeline" \
        "$NATIVE_DIR/../../../raw-pipeline" \
        "$NATIVE_DIR/../../../../raw-pipeline"; do
        if [[ -f "$dir/Cargo.toml" ]]; then
            echo "$(cd "$dir" && pwd)"
            return 0
        fi
    done
    echo "ERROR: cannot find src/raw-pipeline relative to $NATIVE_DIR" >&2
    exit 1
}
RAW_PIPELINE_DIR="$(_find_raw_pipeline)"
RAW_FFI_DIR="$RAW_PIPELINE_DIR/raw-ffi"
FRAMEWORKS_DIR="$NATIVE_DIR/Frameworks"
HEADERS_DIR="$NATIVE_DIR/Packages/MapleCore/Sources/MapleCore/include"

PROFILE="debug"
CARGO_PROFILE_FLAG=""
if [[ "${1:-}" == "--release" ]]; then
    PROFILE="release"
    CARGO_PROFILE_FLAG="--release"
fi

echo "==> build-xcframework.sh"
echo "    raw-ffi:    $RAW_FFI_DIR"
echo "    frameworks: $FRAMEWORKS_DIR"
echo "    profile:    $PROFILE"

# ---------------------------------------------------------------------------
# 0a. Fast-path: skip if no Rust source has changed since the last build.
#
# Stamp file is touched at the end of a successful build. If no `.rs`,
# `Cargo.toml`, `Cargo.lock`, or `cbindgen.toml` under the raw-pipeline
# workspace is newer than the stamp, AND the xcframework still exists, we
# can short-circuit. `--force` bypasses the check.
# ---------------------------------------------------------------------------
XCFW_OUT_PROBE="$NATIVE_DIR/Frameworks/RawPipeline.xcframework"
STAMP="$NATIVE_DIR/Frameworks/.xcframework-stamp.$PROFILE"

if [[ "${FORCE_XCFRAMEWORK_REBUILD:-}" != "1" && "${1:-}" != "--force" && \
      -f "$STAMP" && -d "$XCFW_OUT_PROBE" ]]; then
    changes=$(find "$RAW_PIPELINE_DIR" \
        \( -type d \( -name target -o -name .git -o -name pkg \) -prune \) -o \
        -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \
                  -o -name 'cbindgen.toml' -o -name '*.h' \) \
        -newer "$STAMP" -print 2>/dev/null | head -n 1)
    if [[ -z "$changes" ]]; then
        echo "==> No raw-pipeline changes since last build — skipping."
        exit 0
    fi
    echo "    change detected: $changes"
fi

# ---------------------------------------------------------------------------
# 0. Validate tools
# ---------------------------------------------------------------------------
for tool in cargo cbindgen xcodebuild; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found — install it first."
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# 1. Ensure required Rust targets are installed
# ---------------------------------------------------------------------------
TARGETS=(
    "aarch64-apple-ios"
    "aarch64-apple-ios-sim"
    "aarch64-apple-darwin"   # aarch64-apple-macos
    "x86_64-apple-darwin"    # x86_64-apple-macos
)

for target in "${TARGETS[@]}"; do
    if ! rustup target list --installed | grep -q "^${target}$"; then
        echo "==> Installing Rust target: $target"
        rustup target add "$target"
    fi
done

# ---------------------------------------------------------------------------
# 2. Cargo build for each target
# ---------------------------------------------------------------------------
CARGO_TARGET_DIR="$RAW_PIPELINE_DIR/target"

build_target() {
    local triple="$1"
    echo "==> cargo build [$triple]"
    (
        cd "$RAW_PIPELINE_DIR"
        CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build $CARGO_PROFILE_FLAG \
            --target "$triple" \
            --package raw-ffi \
            2>&1
    )
}

for triple in "${TARGETS[@]}"; do
    build_target "$triple"
done

# ---------------------------------------------------------------------------
# 3. Generate C header via cbindgen
# ---------------------------------------------------------------------------
INCLUDE_DIR="$FRAMEWORKS_DIR/include"
mkdir -p "$INCLUDE_DIR" "$HEADERS_DIR"

echo "==> cbindgen — generating RawPipeline.h"
(
    cd "$RAW_FFI_DIR"
    cbindgen \
        --lang C \
        --output "$INCLUDE_DIR/RawPipeline.h" \
        --crate raw-ffi \
        2>&1
)

# Emit a modulemap so Swift can `import RawPipeline`. Without it, SwiftPM /
# xcodebuild treat the xcframework as a plain static library and the
# `import RawPipeline` line in MapleCore fails.
cat > "$INCLUDE_DIR/module.modulemap" <<'EOM'
module RawPipeline {
    header "RawPipeline.h"
    export *
}
EOM

# Also copy header + modulemap where Swift can find it directly in
# Packages/MapleCore/Sources/MapleCore/include/
cp "$INCLUDE_DIR/RawPipeline.h"    "$HEADERS_DIR/RawPipeline.h"
cp "$INCLUDE_DIR/module.modulemap" "$HEADERS_DIR/module.modulemap"

# ---------------------------------------------------------------------------
# 4. Create fat / xcframework inputs
#
# xcframework layout:
#   RawPipeline.xcframework/
#     ios-arm64/
#       libraw_ffi.a
#       Headers/RawPipeline.h
#     ios-arm64-simulator/
#       libraw_ffi.a    (aarch64-apple-ios-sim)
#       Headers/RawPipeline.h
#     macos-arm64_x86_64/
#       libraw_ffi.a    (lipo of darwin targets)
#       Headers/RawPipeline.h
# ---------------------------------------------------------------------------

LIB_NAME="libraw_ffi.a"

ios_arm64_lib="$CARGO_TARGET_DIR/aarch64-apple-ios/$PROFILE/$LIB_NAME"
ios_sim_lib="$CARGO_TARGET_DIR/aarch64-apple-ios-sim/$PROFILE/$LIB_NAME"
macos_arm64_lib="$CARGO_TARGET_DIR/aarch64-apple-darwin/$PROFILE/$LIB_NAME"
macos_x86_lib="$CARGO_TARGET_DIR/x86_64-apple-darwin/$PROFILE/$LIB_NAME"

STAGING="$FRAMEWORKS_DIR/_staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# iOS arm64
mkdir -p "$STAGING/ios-arm64"
cp "$ios_arm64_lib" "$STAGING/ios-arm64/$LIB_NAME"

# iOS Simulator arm64
mkdir -p "$STAGING/ios-arm64-sim"
cp "$ios_sim_lib" "$STAGING/ios-arm64-sim/$LIB_NAME"

# macOS universal
mkdir -p "$STAGING/macos-universal"
lipo -create \
    "$macos_arm64_lib" \
    "$macos_x86_lib" \
    -output "$STAGING/macos-universal/$LIB_NAME"

# ---------------------------------------------------------------------------
# 5. xcodebuild -create-xcframework
# ---------------------------------------------------------------------------
XCFW_OUT="$FRAMEWORKS_DIR/RawPipeline.xcframework"
rm -rf "$XCFW_OUT"

echo "==> xcodebuild -create-xcframework"
xcodebuild -create-xcframework \
    -library "$STAGING/ios-arm64/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -library "$STAGING/ios-arm64-sim/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -library "$STAGING/macos-universal/$LIB_NAME" \
    -headers "$INCLUDE_DIR" \
    -output "$XCFW_OUT"

# ---------------------------------------------------------------------------
# 6. Cleanup staging dir
# ---------------------------------------------------------------------------
rm -rf "$STAGING"

# Mark this build as up-to-date for the staleness fast-path.
touch "$STAMP"

echo ""
echo "==> Done."
echo "    Output: $XCFW_OUT"
echo ""
echo "Next step: uncomment .binaryTarget and dependency in Package.swift and run swift build."
