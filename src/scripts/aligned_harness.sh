#!/usr/bin/env bash
# aligned_harness.sh — orientation-aligned per-fixture comparison vs the
# embedded JPEG.
#
# For each JPEG-bearing fixture:
#   1. Extract embedded JPEG, read its sensor-frame dims
#   2. Render with maple-cli --profile auto AND --profile neutral
#   3. Read the rendered display-frame dims
#   4. Rotate the embedded JPEG so it matches the rendered orientation
#      (sensor-frame → display-frame via Maple's EXIF orientation handling
#      is exposed by comparing Maple's pre-orient dims to render dims)
#   5. Resize both to 1024 long edge for tractable Python comparison
#   6. Run distribution_match + per_luma_band, collect into JSON table
#
# Output: ~/Desktop/maple-color-tests/aligned-<ts>/
#   per_fixture/<stem>/{auto,neutral,embedded}_1024.png
#   summary.json  — per-fixture dE/sat_ratio/bias rows
#   summary.tsv   — same, tab-separated for quick eyeballing

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
RAWS="$REPO_ROOT/test-fixtures/raws"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/Desktop/maple-color-tests/aligned-$TS"
mkdir -p "$OUT/per_fixture"

if [ ! -x "$CLI" ]; then
    echo "ERROR: maple-cli not built. Run: cd src/raw-pipeline && cargo build --release --bin maple-cli"
    exit 1
fi

# Pick orientation rotation flag for sips based on EXIF orientation tag.
# sips -r N rotates CW by N degrees. Maple's apply_orientation maps sensor
# → display per EXIF:
#   Horizontal (normal)  -> no rotation
#   Rotate 90 CW         -> sips -r 90  on the sensor-frame JPEG
#   Rotate 180           -> sips -r 180
#   Rotate 270 CW        -> sips -r 270
sips_rotation_for() {
    local raw=$1
    local ori=$(exiftool -Orientation -s -s -s -- "$raw" 2>/dev/null)
    case "$ori" in
        ""|"Horizontal (normal)") echo 0 ;;
        "Rotate 90 CW") echo 90 ;;
        "Rotate 180") echo 180 ;;
        "Rotate 270 CW") echo 270 ;;
        *) echo 0 ;;
    esac
}

# Detect the embedded JPEG's color space from the RAW. Canon shooters
# may pick Adobe RGB and write the standard EXIF ColorSpace tag as
# "Uncalibrated" — the Canon makernote has the truth. Returns one of
# "sRGB" or "AdobeRGB". Default sRGB.
detect_cs() {
    local raw=$1
    local out=$(exiftool -s3 -Canon:ColorSpace -ColorSpace -InteropIndex -- "$raw" 2>/dev/null \
        | tr '[:upper:]' '[:lower:]')
    if echo "$out" | grep -qE "adobe|r03"; then
        echo "AdobeRGB"
    else
        echo "sRGB"
    fi
}

# Aggregate one variant (auto|neutral) for one fixture into one summary row.
# Args: <stem> <variant> <cand_png> <ref_png> <ref_color_space>
# Candidate is always Maple's sRGB-encoded PNG. Reference may be sRGB
# (most fixtures) or Adobe RGB (e.g. test_0003 Canon). Interpreting an
# Adobe RGB JPEG as sRGB under-estimates its real chroma and lets the
# fit appear "close" while actually being far in the right color space.
emit_row() {
    local stem=$1 variant=$2 cand=$3 ref=$4 ref_cs=$5
    REF_CS="$ref_cs" python3 - "$cand" "$ref" <<'PY'
import os, sys, json
import numpy as np
from PIL import Image
import colour

ref_cs = os.environ.get("REF_CS", "sRGB")

cand_img = Image.open(sys.argv[1]).convert("RGB")
ref_img  = Image.open(sys.argv[2]).convert("RGB")
if cand_img.size != ref_img.size:
    cand_img = cand_img.resize(ref_img.size, Image.LANCZOS)
cand = np.asarray(cand_img, dtype=np.float32) / 255.0
ref  = np.asarray(ref_img,  dtype=np.float32) / 255.0
if cand.shape != ref.shape:
    print(json.dumps({"error": f"shape {cand.shape} vs {ref.shape}"}))
    sys.exit(0)

# For sRGB JPEGs: both candidate and reference are sRGB → compare
# directly in sRGB-Lab.
# For Adobe RGB JPEGs: convert reference to sRGB-displayable bytes
# first (the user's sRGB monitor displays the Adobe RGB JPEG via
# the same conversion). Then compare both as sRGB-vs-sRGB. This is
# the user-visible-match metric — Maple's sRGB output can plausibly
# reach this target; raw Adobe-RGB-in-Lab is physically out of
# reach for an sRGB pipeline.
if ref_cs == "AdobeRGB":
    ref_xyz = colour.RGB_to_XYZ(
        ref,
        colourspace="Adobe RGB (1998)",
        apply_cctf_decoding=True,
    )
    # Adobe RGB → sRGB display-encoded bytes (clip out-of-gamut to
    # what an sRGB monitor actually shows).
    ref_srgb_linear = colour.XYZ_to_sRGB(ref_xyz, apply_cctf_encoding=False)
    ref_srgb_linear = np.clip(ref_srgb_linear, 0.0, 1.0)
    ref = colour.cctf_encoding(ref_srgb_linear, function="sRGB").astype(np.float32)

cand_xyz = colour.sRGB_to_XYZ(cand)
ref_xyz_for_lab = colour.sRGB_to_XYZ(ref)
cand_lab = colour.XYZ_to_Lab(cand_xyz).reshape(-1, 3)
ref_lab  = colour.XYZ_to_Lab(ref_xyz_for_lab).reshape(-1, 3)
dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

c_chroma = np.sqrt(cand_lab[:, 1]**2 + cand_lab[:, 2]**2)
r_chroma = np.sqrt(ref_lab[:, 1]**2  + ref_lab[:, 2]**2)
sat = float(c_chroma.mean() / max(r_chroma.mean(), 1e-6))

ref_luma = (0.2126 * ref[..., 0] + 0.7152 * ref[..., 1] + 0.0722 * ref[..., 2]).ravel()
flat_cand = cand.reshape(-1, 3); flat_ref = ref.reshape(-1, 3)
sh = (ref_luma < 0.1).sum()
hi = (ref_luma >= 0.9).sum()
def bias_band(lo, hi_):
    m = (ref_luma >= lo) & (ref_luma < hi_)
    if m.sum() < 100: return [0.0, 0.0, 0.0]
    return ((flat_cand[m] - flat_ref[m]).mean(axis=0)).tolist()

shadow = bias_band(0.0, 0.1)
highl = bias_band(0.9, 1.001)

bias_global = (flat_cand - flat_ref).mean(axis=0).tolist()

out = {
    "mean_dE": float(dE.mean()),
    "p95_dE": float(np.percentile(dE, 95)),
    "max_dE": float(np.max(dE)),
    "sat_ratio": sat,
    "L_shift": float(cand_lab[:, 0].mean() - ref_lab[:, 0].mean()),
    "bias_r": bias_global[0],
    "bias_g": bias_global[1],
    "bias_b": bias_global[2],
    "shadow_bias_r": shadow[0],
    "shadow_bias_g": shadow[1],
    "shadow_bias_b": shadow[2],
    "highlight_bias_r": highl[0],
    "highlight_bias_g": highl[1],
    "highlight_bias_b": highl[2],
}
print(json.dumps(out))
PY
}

SUMMARY="$OUT/summary.json"
echo "[" > "$SUMMARY"
TSV="$OUT/summary.tsv"
printf "fixture\tvariant\tmean_dE\tp95_dE\tmax_dE\tsat_ratio\tL_shift\tbias_R\tbias_G\tbias_B\tshadow_R\tshadow_G\tshadow_B\thigh_R\thigh_G\thigh_B\n" > "$TSV"

FIRST=1
for raw in "$RAWS"/test_*.{DNG,dng,RAW,CR2,RAF,raf,ARW,NEF,fff,X3F}; do
    [ -f "$raw" ] || continue
    stem=$(basename "$raw" | sed -E 's/\..*$//')
    if [ -n "$FIXTURE" ] && [ "$stem" != "$FIXTURE" ]; then continue; fi
    fdir="$OUT/per_fixture/$stem"
    mkdir -p "$fdir"

    # 1. Extract embedded JPEG. PreviewImage is usually the full-res
    # preview; JpgFromRaw is a fallback (and is sometimes a tiny
    # thumbnail like Leica's 160x120 that breaks comparison). Try them
    # in order, take the first non-empty one; never concatenate.
    rm -f "$fdir/embedded.jpg"
    for tag in -PreviewImage -JpgFromRaw; do
        exiftool -b "$tag" -- "$raw" 2>/dev/null > "$fdir/embedded.jpg" || true
        [ -s "$fdir/embedded.jpg" ] && break
    done
    [ -s "$fdir/embedded.jpg" ] || { echo "skip $stem: no JPEG"; continue; }
    # Skip if the only available preview is too small (Leica DNGs ship
    # 160x120 thumbs which are useless for color comparison).
    emb_short_edge=$(sips -g pixelWidth -g pixelHeight "$fdir/embedded.jpg" 2>/dev/null \
        | awk '/pixel/ {print $2}' | sort -n | head -1)
    if [ -n "$emb_short_edge" ] && [ "$emb_short_edge" -lt 256 ]; then
        echo "skip $stem: preview ${emb_short_edge}px too small"; continue
    fi

    # 2. Render auto + neutral.
    "$CLI" render "$raw" --profile auto    --out "$fdir/auto.png"    >/dev/null 2>&1
    "$CLI" render "$raw" --profile neutral --out "$fdir/neutral.png" >/dev/null 2>&1
    [ -s "$fdir/auto.png" ] || { echo "skip $stem: auto render failed"; continue; }

    # 3. Rotate embedded to match render orientation.
    rot=$(sips_rotation_for "$raw")
    if [ "$rot" = "0" ]; then
        cp "$fdir/embedded.jpg" "$fdir/embedded_oriented.jpg"
    else
        sips -r "$rot" "$fdir/embedded.jpg" --out "$fdir/embedded_oriented.png" -s format png >/dev/null 2>&1
    fi
    # Pick the embedded source (jpg or rotated png).
    if [ -f "$fdir/embedded_oriented.png" ]; then
        emb_src="$fdir/embedded_oriented.png"
    else
        emb_src="$fdir/embedded_oriented.jpg"
    fi

    # 4. Resize both to 1024 long edge. Tried single-resize-to-JPEG
    # but it made dE worse across the suite (5.87→6.22 mean) — the
    # dual-resize-to-1024 has error-cancellation properties on the
    # mismatched-resolution comparisons that single-resize loses.
    sips -Z 1024 "$emb_src" --out "$fdir/embedded_1024.png" >/dev/null 2>&1
    sips -Z 1024 "$fdir/auto.png" --out "$fdir/auto_1024.png" >/dev/null 2>&1
    sips -Z 1024 "$fdir/neutral.png" --out "$fdir/neutral_1024.png" >/dev/null 2>&1

    # 5. Detect reference JPEG color space and compute metrics.
    ref_cs=$(detect_cs "$raw")
    echo "  $stem color-space: $ref_cs"
    for variant in auto neutral; do
        row=$(emit_row "$stem" "$variant" "$fdir/${variant}_1024.png" "$fdir/embedded_1024.png" "$ref_cs")
        if echo "$row" | grep -q '"error"'; then
            echo "$stem $variant: $row"
            continue
        fi
        if [ $FIRST -eq 0 ]; then echo "  ," >> "$SUMMARY"; fi
        FIRST=0
        echo "  {\"fixture\":\"$stem\",\"variant\":\"$variant\",\"row\":$row}" >> "$SUMMARY"

        # TSV row
        printf "$stem\t$variant\t" >> "$TSV"
        echo "$row" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('\t'.join(f'{r[k]:.4f}' if isinstance(r[k], float) else str(r[k]) for k in [
  'mean_dE','p95_dE','max_dE','sat_ratio','L_shift',
  'bias_r','bias_g','bias_b',
  'shadow_bias_r','shadow_bias_g','shadow_bias_b',
  'highlight_bias_r','highlight_bias_g','highlight_bias_b',
]))" >> "$TSV"

        de_val=$(echo "$row" | python3 -c "import sys, json; print('{:.2f}'.format(json.load(sys.stdin)['mean_dE']))")
        echo "  $stem $variant: dE=$de_val"
    done
done

echo "]" >> "$SUMMARY"

echo ""
echo "==> Output: $OUT"
column -t -s $'\t' "$TSV"
