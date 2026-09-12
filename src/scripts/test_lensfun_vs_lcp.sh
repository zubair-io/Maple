#!/usr/bin/env bash
# test_lensfun_vs_lcp.sh — the bundled Lensfun calibration against Adobe's
# LCP for the same lens (#3566). Two independent calibrations of one lens
# must agree on the warp field within the ceilings recorded in
# test-fixtures/qualification/lensfun-vs-lcp.json. Compares the resolved
# warp fields directly (maple-cli render --lens-warp-out), no pixels.
#
# Skips (exit 0) when the RAW or the Adobe profile is absent — both are
# local-only (the RAW is gitignored, the profile is Adobe's, never bundled).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RAW="${RAW:-$ROOT/test-fixtures/raws/test_0011.ARW}"
LCP="${LCP:-/Library/Application Support/Adobe/CameraRaw/LensProfiles/1.0/Sony/SONY (Sony FE 24-70mm F4 ZA OSS) - RAW.lcp}"
CEILINGS="$ROOT/test-fixtures/qualification/lensfun-vs-lcp.json"
if [ ! -f "$RAW" ] || [ ! -f "$LCP" ]; then
  echo "lensfun-vs-lcp: RAW or Adobe LCP absent, skipping"
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CLI=(cargo run --release --quiet --manifest-path "$ROOT/src/raw-pipeline/Cargo.toml" --bin maple-cli --)
"${CLI[@]}" render "$RAW" --lens auto --lens-warp-out "$TMP/lensfun.json" --out "$TMP/unused.png"
"${CLI[@]}" render "$RAW" --lens-profile "$LCP" --acknowledge-lens-approximation --lens-warp-out "$TMP/lcp.json" --out "$TMP/unused.png"
if [ ! -f "$CEILINGS" ]; then
  python3 "$ROOT/src/scripts/lens_warp_diff.py" "$TMP/lensfun.json" "$TMP/lcp.json" "$CEILINGS" --record
else
  python3 "$ROOT/src/scripts/lens_warp_diff.py" "$TMP/lensfun.json" "$TMP/lcp.json" "$CEILINGS"
fi
