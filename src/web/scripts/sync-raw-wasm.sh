#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_SOURCE="$(cd "$WORKSPACE_ROOT/../raw-pipeline/raw-wasm/pkg" && pwd)"
PKG_DEST="$WORKSPACE_ROOT/projects/maple-common/src/lib/raw-pipeline/pkg"

if [ ! -d "$PKG_SOURCE" ]; then
  echo "ERROR: $PKG_SOURCE does not exist. Run src/raw-pipeline/scripts/build-raw-wasm.sh first." >&2
  echo "       (wasm-bindgen-rayon needs --features parallel + -Z build-std flags;" >&2
  echo "        the helper script wraps the canonical wasm-pack invocation.)" >&2
  exit 1
fi

mkdir -p "$(dirname "$PKG_DEST")"
rm -rf "$PKG_DEST"
cp -R "$PKG_SOURCE" "$PKG_DEST"
echo "Synced raw-wasm pkg/ -> projects/maple-common/src/lib/raw-pipeline/pkg/"
