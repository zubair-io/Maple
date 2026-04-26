#!/usr/bin/env bash
# build-raw-wasm.sh — build the raw-wasm crate for the web app.
#
# wasm-bindgen-rayon requires specific flags that wasm-pack alone doesn't
# infer. Without `--features parallel` and `-Z build-std=panic_abort,std`,
# the resulting wasm either panics with "time not implemented" or fails
# to link with rayon TLS errors. Centralise the canonical command so
# nobody has to re-derive it.
#
# Usage: ./scripts/build-raw-wasm.sh
# Output: src/raw-pipeline/raw-wasm/pkg/

set -euo pipefail

# Self-set PATH for environments (Xcode, CI) that don't include the
# Rust toolchain by default.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_WASM_DIR="$(cd "$SCRIPT_DIR/../raw-wasm" && pwd)"

cd "$RAW_WASM_DIR"
echo "==> wasm-pack build --target web --release  (parallel + build-std)"
wasm-pack build --target web --release -- \
    --features parallel \
    -Z build-std=panic_abort,std

echo "==> Done. Output: $RAW_WASM_DIR/pkg/"
echo "    Sync into the web project with: src/web/scripts/sync-raw-wasm.sh"
