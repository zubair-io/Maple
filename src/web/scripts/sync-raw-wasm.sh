#!/usr/bin/env bash
set -euo pipefail
#
# Sync the raw-wasm wasm-pack build output into the Angular workspace.
#
# Standard (no panorama stitch):
#   ./scripts/sync-raw-wasm.sh
#   The PKG_SOURCE must already exist — build it first with:
#     src/raw-pipeline/scripts/build-raw-wasm.sh
#   or manually:
#     cd src/raw-pipeline/raw-wasm && wasm-pack build --target web
#
# Panorama stitch (T5.5):
#   The panorama worker (panorama.worker.ts) requires a WASM bundle built
#   with the `pano` feature enabled.  The default bundle does NOT include it.
#   To rebuild with pano support:
#     cd src/raw-pipeline/raw-wasm
#     wasm-pack build --target web --features pano
#   Then re-run this sync script.
#   NOTE: the `pano` and `parallel` features are independent — to get both
#   threading AND pano in one bundle:
#     wasm-pack build --target web --features pano,parallel \
#       -- -Z build-std=panic_abort,std
#
# The panorama worker loads the same pkg/ bundle as the main decode worker.
# If the bundle was NOT built with --features pano, PanoHandle.stitch is
# absent and the worker will throw:
#   "TypeError: PanoHandle.stitch is not a function"
# That is a clear, actionable error — no silent fallback.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_SOURCE="$(cd "$WORKSPACE_ROOT/../raw-pipeline/raw-wasm/pkg" && pwd)"
PKG_DEST="$WORKSPACE_ROOT/projects/maple-common/src/lib/raw-pipeline/pkg"

if [ ! -d "$PKG_SOURCE" ]; then
  echo "ERROR: $PKG_SOURCE does not exist. Run src/raw-pipeline/scripts/build-raw-wasm.sh first." >&2
  echo "       (wasm-bindgen-rayon needs --features parallel + -Z build-std flags;" >&2
  echo "        the helper script wraps the canonical wasm-pack invocation.)" >&2
  echo "       For panorama support add --features pano to the wasm-pack invocation." >&2
  exit 1
fi

mkdir -p "$(dirname "$PKG_DEST")"
rm -rf "$PKG_DEST"
cp -R "$PKG_SOURCE" "$PKG_DEST"
echo "Synced raw-wasm pkg/ -> projects/maple-common/src/lib/raw-pipeline/pkg/"
