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

# Fast-path: skip if no Rust source has changed since the last successful
# build. Stamp is touched at the end on success. Set FORCE_WASM_REBUILD=1 or
# pass --force to bypass.
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAMP="$SCRIPT_DIR/pkg/.build-stamp"

if [[ "${FORCE_WASM_REBUILD:-}" != "1" && "${1:-}" != "--force" && \
      -f "$STAMP" && -d "$SCRIPT_DIR/pkg" ]]; then
    changes=$(find "$WORKSPACE_DIR" \
        \( -type d \( -name target -o -name .git -o -name pkg \) -prune \) -o \
        -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) \
        -newer "$STAMP" -print -quit 2>/dev/null)
    if [[ -z "$changes" ]]; then
        echo "[raw-wasm] No source changes since last build — skipping."
        exit 0
    fi
    echo "[raw-wasm] change detected: $changes"
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "ERROR: wasm-pack not found. Install with: cargo install wasm-pack" >&2
  exit 1
fi

# --features gpu,parallel co-builds wgpu (WebGPU live render, epic #925 / #1059)
# AND wasm-bindgen-rayon (multi-threaded CPU decode) into ONE shipped bundle: the
# worker picks the GPU entry (`render_bytes_gpu` / `WebLiveSession`) when WebGPU is
# present (`'gpu' in navigator`) and falls back to threaded-CPU `render_bytes`
# otherwise. The two features co-exist (spike-confirmed) — no dual bundle.
echo "[raw-wasm] Building with --features gpu,parallel (wgpu WebGPU + atomics + bulk-memory + rayon)"
wasm-pack build \
  --target web \
  --release \
  --out-dir pkg \
  -- \
  --features gpu,parallel \
  -Z build-std=panic_abort,std

touch "$STAMP"

echo ""
echo "[raw-wasm] Build complete: $(pwd)/pkg"
echo "[raw-wasm] Next: bash ../../web/scripts/sync-raw-wasm.sh"
