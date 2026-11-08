#!/usr/bin/env bash
#
# Build the raw-wasm crate into a wasm-pack `pkg/` directory with threading
# (wasm-bindgen-rayon) enabled, then the main thread's small canvas zoom
# module (raw-wasm-canvas, #5714) into `pkg/canvas/`.
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

# Unthreaded: no atomics rustflags (those live in raw-wasm/.cargo/config.toml,
# which a build from raw-wasm-canvas/ never reads) and no build-std, so it gets
# an ordinary unshared memory. Its own target dir keeps the two flag sets from
# invalidating each other's wasm32 artifacts.
build_canvas() {
	echo "[raw-wasm] Building raw-wasm-canvas (main-thread canvas zoom model)"
	(
		cd "$WORKSPACE_DIR/raw-wasm-canvas"
		CARGO_TARGET_DIR="$WORKSPACE_DIR/target/wasm-canvas" wasm-pack build \
			--target web \
			--release \
			--out-dir "$SCRIPT_DIR/pkg/canvas"
	)
}

# Fast-path: skip if no Rust source has changed since the last successful
# build. Stamp is touched at the end on success. Set FORCE_WASM_REBUILD=1 or
# pass --force to bypass.
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAMP="$SCRIPT_DIR/pkg/.build-stamp"
CANVAS_WASM="$SCRIPT_DIR/pkg/canvas/raw_wasm_canvas_bg.wasm"

if [[ "${FORCE_WASM_REBUILD:-}" != "1" && "${1:-}" != "--force" &&
	-f "$STAMP" ]]; then
	changes=$(find "$WORKSPACE_DIR" \
		\( -type d \( -name target -o -name .git -o -name pkg \) -prune \) -o \
		-type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) \
		-newer "$STAMP" -print -quit 2>/dev/null)
	if [[ -z "$changes" && -f "$CANVAS_WASM" ]]; then
		echo "[raw-wasm] No source changes since last build — skipping."
		exit 0
	fi
	if [[ -z "$changes" ]]; then
		build_canvas
		touch "$STAMP"
		exit 0
	fi
	echo "[raw-wasm] change detected: $changes"
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
	echo "ERROR: wasm-pack not found. Install with: cargo install wasm-pack" >&2
	exit 1
fi

# --features gpu,parallel,avif co-builds wgpu (WebGPU live render, epic #925 / #1059)
# AND wasm-bindgen-rayon (multi-threaded CPU decode) into ONE shipped bundle: the
# worker picks the GPU entry (`render_bytes_gpu` / `WebLiveSession`) when WebGPU is
# present (`'gpu' in navigator`) and falls back to threaded-CPU `render_bytes`
# otherwise. AVIF enables the existing shared export encoder in this bundle.
echo "[raw-wasm] Building with --features gpu,parallel,avif (wgpu WebGPU + atomics + bulk-memory + rayon)"
wasm-pack build \
	--target web \
	--release \
	--out-dir pkg \
	-- \
	--features gpu,parallel,avif \
	-Z build-std=panic_abort,std

build_canvas

touch "$STAMP"

echo ""
echo "[raw-wasm] Build complete: $(pwd)/pkg"
echo "[raw-wasm] Next: bash ../../web/scripts/sync-raw-wasm.sh"
