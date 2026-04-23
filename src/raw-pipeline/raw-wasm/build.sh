#!/usr/bin/env bash
#
# Build the raw-wasm crate into a wasm-pack `pkg/` directory with threading
# (wasm-bindgen-rayon) enabled.
#
# Prerequisites (one-time):
#   cargo install wasm-pack
#   # nightly toolchain + rust-src + wasm32 target are pinned in
#   # raw-wasm/rust-toolchain.toml, so rustup installs them automatically the
#   # first time this script runs.
#
# The target features (+atomics,+bulk-memory,+mutable-globals) come from
# raw-wasm/.cargo/config.toml. `-Z build-std=panic_abort,std` rebuilds the
# standard library with those same features so atomic operations link cleanly.
#
# After a successful build, run `bash src/web/scripts/sync-raw-wasm.sh` to
# copy the pkg/ output into maple-common.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "ERROR: wasm-pack not found. Install with: cargo install wasm-pack" >&2
  exit 1
fi

echo "[raw-wasm] Building with --features parallel (atomics + bulk-memory + rayon)"
wasm-pack build \
  --target web \
  --release \
  --out-dir pkg \
  -- \
  --features parallel \
  -Z build-std=panic_abort,std

echo ""
echo "[raw-wasm] Build complete: $(pwd)/pkg"
echo "[raw-wasm] Next: bash ../../web/scripts/sync-raw-wasm.sh"
