#!/usr/bin/env bash
# build-raw-wasm.sh — build the raw-wasm crate for the web app.
#
# wasm-bindgen-rayon requires specific flags that wasm-pack alone doesn't
# infer. Without `--features parallel` and `-Z build-std=panic_abort,std`,
# the resulting wasm either panics with "time not implemented" or fails
# to link with rayon TLS errors. `--features gpu` additionally co-builds
# wgpu (the WebGPU live-render chain, epic #925 / #1059) into the SAME bundle;
# `avif` enables the existing shared export encoder. ONE shipped bundle lets
# the worker pick the GPU entry when WebGPU is present and the threaded-CPU
# `render_bytes` otherwise. Centralise the canonical command so nobody has to
# re-derive it.
#
# Usage: ./scripts/build-raw-wasm.sh
# Output: src/raw-pipeline/raw-wasm/pkg/

set -euo pipefail

# Self-set PATH for environments (Xcode, CI) that don't include the
# Rust toolchain by default.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_WASM_DIR="$(cd "$SCRIPT_DIR/../raw-wasm" && pwd)"

# Keep one canonical feature/build-std command. This wrapper historically
# always rebuilt, so retain that behavior while providing its PATH bootstrap.
exec bash "$RAW_WASM_DIR/build.sh" --force
