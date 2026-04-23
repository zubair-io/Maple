#!/usr/bin/env bash
# build-raw-ffi.sh — Build libraw_ffi shared library for the current platform
# and copy it to src/maple-self-hosted/native/.
#
# Usage:
#   ./scripts/build-raw-ffi.sh            # auto-detects platform
#   ./scripts/build-raw-ffi.sh macos      # force macOS aarch64
#   ./scripts/build-raw-ffi.sh linux      # cross-compile for x86_64-linux-gnu
#
# Prerequisites:
#   - Rust + Cargo (https://rustup.rs)
#   - For Linux cross-compile: `cross` (cargo install cross) + Docker
#     OR a native Linux build box / CI runner.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_HOSTED_DIR="$(dirname "$SCRIPT_DIR")"
RAW_PIPELINE_DIR="$(dirname "$SELF_HOSTED_DIR")/raw-pipeline"
NATIVE_OUT="$SELF_HOSTED_DIR/native"

mkdir -p "$NATIVE_OUT"

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

PLATFORM="${1:-auto}"

if [[ "$PLATFORM" == "auto" ]]; then
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  if [[ "$OS" == "Darwin" ]]; then
    PLATFORM="macos"
  elif [[ "$OS" == "Linux" ]]; then
    PLATFORM="linux"
  else
    echo "Unsupported platform: $OS" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

case "$PLATFORM" in
  macos)
    # Detect macOS architecture.
    ARCH="$(uname -m)"
    case "$ARCH" in
      arm64)  TARGET="aarch64-apple-darwin" ;;
      x86_64) TARGET="x86_64-apple-darwin" ;;
      *)      echo "Unknown macOS arch: $ARCH" >&2; exit 1 ;;
    esac

    echo "Building libraw_ffi.dylib for $TARGET..."
    (cd "$RAW_PIPELINE_DIR" && cargo build --release -p raw-ffi --target "$TARGET")

    SRC="$RAW_PIPELINE_DIR/target/$TARGET/release/libraw_ffi.dylib"
    DEST="$NATIVE_OUT/libraw_ffi.dylib"
    cp "$SRC" "$DEST"
    echo "Copied: $DEST ($(du -sh "$DEST" | cut -f1))"
    ;;

  linux)
    # Cross-compile for x86_64-unknown-linux-gnu using `cross`.
    # TODO: This requires `cross` (cargo install cross) and Docker.
    #
    # Steps for a developer who wants to build a Linux Docker image:
    #
    #   1. Install cross:
    #        cargo install cross --git https://github.com/cross-rs/cross
    #
    #   2. Run this script with `linux` on a machine with Docker:
    #        ./scripts/build-raw-ffi.sh linux
    #
    #   3. The output will be at native/libraw_ffi.so, which the Dockerfile
    #      COPY-s into /app/native/.
    #
    # Alternatively, build natively on a Linux box:
    #   cargo build --release -p raw-ffi --target x86_64-unknown-linux-gnu

    TARGET="x86_64-unknown-linux-gnu"

    if command -v cross &>/dev/null; then
      echo "Building libraw_ffi.so for $TARGET using cross..."
      (cd "$RAW_PIPELINE_DIR" && cross build --release -p raw-ffi --target "$TARGET")
    else
      echo "Building libraw_ffi.so for $TARGET using cargo (assumes native Linux)..."
      (cd "$RAW_PIPELINE_DIR" && cargo build --release -p raw-ffi --target "$TARGET")
    fi

    SRC="$RAW_PIPELINE_DIR/target/$TARGET/release/libraw_ffi.so"
    DEST="$NATIVE_OUT/libraw_ffi.so"
    cp "$SRC" "$DEST"
    echo "Copied: $DEST ($(du -sh "$DEST" | cut -f1))"
    ;;

  *)
    echo "Unknown platform: $PLATFORM" >&2
    echo "Usage: $0 [auto|macos|linux]" >&2
    exit 1
    ;;
esac

echo ""
echo "Done. Restart bun src/index.ts — the indexer will now render RAW thumbnails."
