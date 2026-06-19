#!/usr/bin/env bash
# Color baseline run — builds maple-cli, renders all fixtures with
# Profile=Auto AND Profile=Neutral, extracts embedded JPEGs (the
# camera-intended target), and produces per-pixel residual analysis.
#
# Usage:
#     src/scripts/run_color_baseline.sh
#
# Output:
#     ~/Desktop/maple-color-tests/baseline-<timestamp>/
#         auto_png/       — Profile=Auto, lossless PNG (for diff scripts)
#         auto_jpg/       — Profile=Auto, JPG q92 (for eyeball review)
#         neutral_png/    — Profile=Neutral (AgX), PNG
#         neutral_jpg/    — Profile=Neutral (AgX), JPG q92
#         embedded_jpeg/  — Camera's embedded JPEG preview (the target)
#         analysis/       — fit_curves.py per-pixel residuals (Auto vs embedded)
#         SUMMARY.md      — paths + counts + notes

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ─── 1. Build ─────────────────────────────────────────────────────────────
echo "==> Building maple-cli (release)"
(cd src/raw-pipeline && cargo build --release --bin maple-cli 2>&1 | tail -3)

CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
RAWS="$REPO_ROOT/test-fixtures/raws"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/Desktop/maple-color-tests/baseline-$TS"
mkdir -p "$OUT"/{auto_png,auto_jpg,neutral_png,neutral_jpg,embedded_jpeg,analysis}

# ─── 2. Render ────────────────────────────────────────────────────────────
echo "==> Rendering 17 fixtures × (Auto+Neutral) × (PNG+JPG)"

# Cap concurrency: each `maple-cli render` on a 100MP frame can hold ~1 GB
# resident, and unconstrained backgrounding spawns 4 × N_FIXTURES jobs at
# once. Default to the number of logical CPUs (override via JOBS=).
: "${JOBS:=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

throttle() {
    while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do
        wait -n 2>/dev/null || sleep 0.1
    done
}

for raw in "$RAWS"/test_*.{DNG,dng,RAW,CR2,RAF,raf,ARW,NEF,fff}; do
    [ -f "$raw" ] || continue
    stem=$(basename "$raw" | sed -E 's/\..*$//')
    throttle; "$CLI" render "$raw" --profile auto    --out "$OUT/auto_png/${stem}.png"    2>/dev/null &
    throttle; "$CLI" render "$raw" --profile auto    --out "$OUT/auto_jpg/${stem}.jpg"    2>/dev/null &
    throttle; "$CLI" render "$raw" --profile neutral --out "$OUT/neutral_png/${stem}.png" 2>/dev/null &
    throttle; "$CLI" render "$raw" --profile neutral --out "$OUT/neutral_jpg/${stem}.jpg" 2>/dev/null &
done
wait

# ─── 3. Extract embedded JPEG (target) ────────────────────────────────────
# maple-cli extract-preview is on T8 PR #548; until that merges, use exiftool
# which every macOS dev box has via Homebrew.
echo "==> Extracting embedded JPEG previews"

if command -v exiftool >/dev/null 2>&1; then
    for raw in "$RAWS"/test_*.{DNG,dng,RAW,CR2,RAF,raf,ARW,NEF,fff}; do
        [ -f "$raw" ] || continue
        stem=$(basename "$raw" | sed -E 's/\..*$//')
        exiftool -b -JpgFromRaw -PreviewImage -- "$raw" 2>/dev/null > "$OUT/embedded_jpeg/${stem}.jpg" || true
        # Drop zero-byte outputs (fixtures with no embedded JPEG)
        [ -s "$OUT/embedded_jpeg/${stem}.jpg" ] || rm -f "$OUT/embedded_jpeg/${stem}.jpg"
    done
else
    echo "  exiftool not installed — skipping embedded-JPEG extraction"
    echo "  (after T8 #548 merges, switch this to: $CLI extract-preview <RAW> --out <JPG>)"
fi

# ─── 4. Per-pixel residual analysis (Auto vs embedded JPEG) ───────────────
echo "==> Per-pixel residual analysis"

if [ -f "$REPO_ROOT/src/scripts/fit_curves.py" ]; then
    for ext_jpeg in "$OUT/embedded_jpeg"/*.jpg; do
        [ -f "$ext_jpeg" ] || continue
        stem=$(basename "$ext_jpeg" .jpg)
        auto_png="$OUT/auto_png/${stem}.png"
        [ -f "$auto_png" ] || continue
        mkdir -p "$OUT/analysis/${stem}"
        echo "  ${stem}:"
        python3 "$REPO_ROOT/src/scripts/fit_curves.py" \
            "$auto_png" "$ext_jpeg" \
            --out "$OUT/analysis/${stem}" --matrix 2>&1 \
            | grep -E "^\[stage|VERDICT" \
            | sed 's/^/    /'
    done
else
    echo "  fit_curves.py not present — skipping residual analysis"
fi

# ─── 5. Summary ───────────────────────────────────────────────────────────
cat > "$OUT/SUMMARY.md" <<EOF
# Color baseline — $TS

main HEAD: \`$(git -C "$REPO_ROOT" rev-parse --short HEAD)\`

## Counts
- auto_png:       $(ls "$OUT/auto_png" 2>/dev/null       | wc -l | tr -d ' ')
- auto_jpg:       $(ls "$OUT/auto_jpg" 2>/dev/null       | wc -l | tr -d ' ')
- neutral_png:    $(ls "$OUT/neutral_png" 2>/dev/null    | wc -l | tr -d ' ')
- neutral_jpg:    $(ls "$OUT/neutral_jpg" 2>/dev/null    | wc -l | tr -d ' ')
- embedded_jpeg:  $(ls "$OUT/embedded_jpeg" 2>/dev/null  | wc -l | tr -d ' ')

## What to look at
- Visual A/B/C: open \`auto_jpg/test_NNNN.jpg\` next to \`embedded_jpeg/test_NNNN.jpg\` and \`neutral_jpg/test_NNNN.jpg\`.
- Residual heatmap: \`analysis/test_NNNN/residual_stage1.png\` — bright = where the Auto Profile curve disagrees with the embedded JPEG. Flat noise = good. Structured = curve fit problem.
EOF

echo ""
echo "==> Done. Output: $OUT"
echo "    open $OUT"
