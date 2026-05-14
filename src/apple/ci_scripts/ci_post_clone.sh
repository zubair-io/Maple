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
# (Don't use CI_WORKSPACE — deprecated since Xcode 14 and ambiguous: in some
# contexts it points at the selected workspace/project rather than the
# repo root.) Fall back to the script's own location for local testing —
# this file lives at <repo>/src/apple/ci_scripts/, so ../../.. is the root.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
APPLE_DIR="$REPO_ROOT/src/apple"

if [ ! -x "$APPLE_DIR/scripts/build-xcframework.sh" ]; then
    echo "ERROR: build-xcframework.sh not found at $APPLE_DIR/scripts/" >&2
    exit 1
fi

# Install Rust. rustup is not preinstalled on Xcode Cloud workers, and the
# canonical `curl https://sh.rustup.rs | sh` bootstrap fails because the
# worker pool's DNS does not resolve sh.rustup.rs (curl exits 6, the pipe
# masks it, and the next step blows up with `cargo: command not found`).
# Use the preinstalled Homebrew instead — bottles are served from GitHub,
# which the workers can reach.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v rustup >/dev/null 2>&1; then
    echo "==> brew install rustup-init"
    brew install rustup-init
    echo "==> rustup-init"
    rustup-init -y --default-toolchain stable --profile minimal --no-modify-path
fi

# rustup-init installs to ~/.cargo/bin; cargo install lands binaries there too.
export PATH="$HOME/.cargo/bin:$PATH"

# build-xcframework.sh validates these are on PATH and adds targets itself,
# but cbindgen is a separate cargo install that we need to handle here.
# Pin the version so a future cbindgen release can't silently change
# generated headers or fail to build with the toolchain pinned above. Bump
# this in sync with whatever local devs are running (see CLAUDE.md).
CBINDGEN_VERSION="0.29.2"
installed_cbindgen_version="$(cbindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$installed_cbindgen_version" != "$CBINDGEN_VERSION" ]; then
    echo "==> cargo install cbindgen@$CBINDGEN_VERSION"
    cargo install cbindgen --locked --version "$CBINDGEN_VERSION"
fi

# --release matches what an archive build should link against.
echo "==> Building RawPipeline.xcframework (release)"
"$APPLE_DIR/scripts/build-xcframework.sh" --release

echo "==> ci_post_clone.sh done"
