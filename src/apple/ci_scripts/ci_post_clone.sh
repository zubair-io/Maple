#!/bin/sh
# ci_post_clone.sh — Xcode Cloud hook that rebuilds RawPipeline.xcframework.
#
# The xcframework's .a binaries are gitignored (~200-500 MB each, over
# GitHub's per-file limit), so a fresh checkout on an Xcode Cloud worker has
# the framework skeleton (Info.plist, Headers/, modulemap) but no
# libraw_ffi.a. Without this script the archive job fails with:
#
#   When building for iOS, the expected library
#   .../RawPipeline.xcframework/ios-arm64/libraw_ffi.a was not found
#
# This runs after the repo is cloned and before xcodebuild kicks off. It
# installs the Rust toolchain + cbindgen + the four Apple Rust targets and
# invokes scripts/build-xcframework.sh to produce the missing static libs.

set -eu

echo "==> ci_post_clone.sh — preparing RawPipeline.xcframework"

# Xcode Cloud sets CI_PRIMARY_REPOSITORY_PATH to the cloned repo root.
# Fall back to walking up from this script's location for local testing.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-${CI_WORKSPACE:-$(cd "$SCRIPT_DIR/../../.." && pwd)}}"
APPLE_DIR="$REPO_ROOT/src/apple"

if [ ! -x "$APPLE_DIR/scripts/build-xcframework.sh" ]; then
    echo "ERROR: build-xcframework.sh not found at $APPLE_DIR/scripts/" >&2
    exit 1
fi

# Install Rust (rustup is not preinstalled on Xcode Cloud workers).
if ! command -v rustup >/dev/null 2>&1; then
    echo "==> Installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal
fi

# rustup installs to ~/.cargo/bin; cargo install lands binaries there too.
export PATH="$HOME/.cargo/bin:$PATH"

# build-xcframework.sh validates these are on PATH and adds targets itself,
# but cbindgen is a separate cargo install that we need to handle here.
if ! command -v cbindgen >/dev/null 2>&1; then
    echo "==> cargo install cbindgen"
    cargo install cbindgen --locked
fi

# --release matches what an archive build should link against.
echo "==> Building RawPipeline.xcframework (release)"
"$APPLE_DIR/scripts/build-xcframework.sh" --release

echo "==> ci_post_clone.sh done"
