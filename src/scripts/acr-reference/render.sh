#!/usr/bin/env bash
# render.sh — drive Photoshop 2026 + ACR headlessly via osascript.
#
# Reads test-fixtures/references/manifest.json (produced by run.py) and
# dispatches acr_batch.jsx into Photoshop. Photoshop must be installed but
# does NOT need to be in the foreground — osascript will launch it if needed.
#
# Usage:
#   ./src/scripts/acr-reference/render.sh
#
# Optional env:
#   MAPLE_ROOT        host path to repo (default: /Users/riabuz/Projects/_Maple)
#   PHOTOSHOP_APP     full app name (default: "Adobe Photoshop 2026")
#
# Exit codes: 0 on success, 2 on missing inputs, non-zero on Photoshop error.

set -euo pipefail

MAPLE_ROOT="${MAPLE_ROOT:-/Users/riabuz/Projects/_Maple}"
PHOTOSHOP_APP="${PHOTOSHOP_APP:-Adobe Photoshop 2026}"
JSX="$MAPLE_ROOT/src/scripts/acr-reference/acr_batch.jsx"
MANIFEST="$MAPLE_ROOT/test-fixtures/references/manifest.json"

err() { printf "render.sh: %s\n" "$*" >&2; }

[[ -f "$JSX" ]]      || { err "missing .jsx: $JSX";      exit 2; }
[[ -f "$MANIFEST" ]] || { err "missing manifest: $MANIFEST"; exit 2; }

# Count cases for progress visibility.
case_count=$(grep -c '"name"' "$MANIFEST" || true)
echo "render.sh: $PHOTOSHOP_APP ← manifest with $case_count cases"
echo "           jsx: $JSX"
echo "           log: $MAPLE_ROOT/test-fixtures/references/acr_batch.log"
echo ""

# `do javascript of file` is blocking — osascript returns when the .jsx returns.
# The .jsx runs silently (DialogModes.NO) except for the final alert().
osascript -e "tell application \"$PHOTOSHOP_APP\" to activate" \
          -e "tell application \"$PHOTOSHOP_APP\" to do javascript of file \"$JSX\""

echo ""
echo "render.sh: done. Check acr_batch.log for per-case timing + errors."
echo "render.sh: to clean up <raw>.xmp leftovers next to each RAW, run:"
echo "   python3 $MAPLE_ROOT/src/scripts/acr-reference/run.py \\"
echo "       --raws $MAPLE_ROOT/test-fixtures/raws/test_*.* \\"
echo "       --out  $MAPLE_ROOT/test-fixtures/references/ \\"
echo "       --cleanup-only"
