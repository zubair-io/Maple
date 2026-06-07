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

# Retry a command with exponential backoff. Xcode Cloud's worker network has
# intermittent DNS failures resolving static.rust-lang.org / crates.io (the
# same flakiness build-xcframework.sh vendors around for the crate build). A
# single transient getaddrinfo failure must not fail the whole archive, so
# every toolchain/crate fetch goes through here.
retry() {
    _attempt=1
    _max=5
    _delay=5
    while :; do
        if "$@"; then
            return 0
        fi
        if [ "$_attempt" -ge "$_max" ]; then
            echo "ERROR: '$*' failed after $_max attempts" >&2
            return 1
        fi
        echo "==> attempt $_attempt/$_max failed: '$*' — retrying in ${_delay}s" >&2
        sleep "$_delay"
        _attempt=$((_attempt + 1))
        _delay=$((_delay * 2))
    done
}

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
    echo "==> brew install rustup"
    retry brew install rustup
    # `rustup` is keg-only because it conflicts with `rust`, so brew does
    # not symlink it into /opt/homebrew/bin (or /usr/local/bin on Intel
    # workers). Add the keg's bin to PATH ourselves. (export inside this
    # `if` persists past `fi` — no subshell — so the unconditional toolchain
    # install below sees rustup on PATH whether brew just installed it or it
    # was already present.)
    export PATH="$(brew --prefix rustup)/bin:$PATH"
fi

# As of formula 1.29.0_1, Homebrew's `rustup` ships `rustup` but no longer
# ships the `rustup-init` bootstrap binary — see brew caveats ("This formula
# does not provide rustup-init."). Install the default toolchain via `rustup`
# directly. --no-self-update keeps `rustup` itself brew-managed so brew can
# upgrade it cleanly later.
#
# Ensure the pinned toolchain, the components rust-toolchain.toml requests
# (rustfmt, clippy), and every Apple cross-compile target are installed in ONE
# retry-wrapped step. Doing it here — rather than letting the first cargo run
# lazily fetch the components, or letting build-xcframework.sh `rustup target
# add` them — collapses the toolchain network I/O into a single retry-guarded
# operation, and makes build-xcframework.sh's target-add loop a no-op on CI.
echo "==> rustup toolchain install stable (+ rustfmt/clippy + Apple targets)"
retry rustup toolchain install stable \
    --profile minimal \
    --component rustfmt --component clippy \
    --target aarch64-apple-ios \
    --target aarch64-apple-ios-sim \
    --target aarch64-apple-darwin \
    --target x86_64-apple-darwin \
    --no-self-update
rustup default stable

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
    retry cargo install cbindgen --locked --version "$CBINDGEN_VERSION"
fi

# --release matches what an archive build should link against.
echo "==> Building RawPipeline.xcframework (release)"
"$APPLE_DIR/scripts/build-xcframework.sh" --release

echo "==> ci_post_clone.sh done"
