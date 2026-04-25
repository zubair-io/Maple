#!/bin/bash
# test_color_pipeline.sh — perceptual color-parity gate for the Rust raw pipeline.
#
# Per CLAUDE.md § "Objective color testing — no eyeballing":
#   "Every color-pipeline change must pass the perceptual harness.
#    Screenshot comparisons are not acceptable evidence."
#
# For each DNG fixture present under <repo-root>/test-fixtures/raws/:
#   1. Read PreviewImageStart / PreviewImageLength via exiftool.
#   2. Extract the embedded JPEG preview via dd (the reference).
#   3. Render the same DNG via maple-cli (the candidate, full-quality PNG).
#   4. Resize the candidate to the reference's dimensions.
#   5. Diff via compare_images.py (CIEDE2000 + per-channel bias).
#   6. Compare each metric against its budget.
#
# Reports mean ΔE₀₀, P95, max, and per-channel bias per fixture.
# A case passes only when all four are under budget.
#
# CI gate: exits 0 if all present fixtures pass; non-zero if any fail.
# If no fixtures are present (e.g. CI without the gitignored RAWs), exits 0
# with a "no fixtures, skipping" message — CI doesn't fail spuriously.
#
# Env overrides (the four budgets that gate a pass):
#   BUDGET      = mean ΔE₀₀ threshold      (default 15)
#   BUDGET_P95  = P95  ΔE₀₀ threshold      (default 2 × BUDGET)
#   BUDGET_MAX  = max  ΔE₀₀ threshold      (default 4 × BUDGET)
#   BUDGET_BIAS = abs per-channel bias cap (default 0.05, i.e. 5% of [0,1])
#
# As of ticket #07, both DNG photometric paths (CFA mosaic, LinearRaw) are
# covered. BlackIsZero monochrome is rejected at decode by the Rust core
# (Error::UnsupportedCfa) and produces a render failure, not a SKIP.
#
# Usage:
#   src/scripts/test_color_pipeline.sh                # default budgets
#   BUDGET=5 src/scripts/test_color_pipeline.sh       # tighten the mean gate
#   BUDGET=25 src/scripts/test_color_pipeline.sh      # looser budget for LinearRaw fixtures

set -euo pipefail

# ----- repo root -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FIXTURES_DIR="$REPO_ROOT/test-fixtures/raws"
COMPARE_PY="$REPO_ROOT/src/scripts/compare_images.py"
MAPLE_CLI_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

# ----- budgets -------------------------------------------------------------
BUDGET="${BUDGET:-15}"
BUDGET_P95="${BUDGET_P95:-$(awk -v b="$BUDGET" 'BEGIN { printf "%g", b * 2 }')}"
BUDGET_MAX="${BUDGET_MAX:-$(awk -v b="$BUDGET" 'BEGIN { printf "%g", b * 4 }')}"
BUDGET_BIAS="${BUDGET_BIAS:-0.05}"

# ----- preflight -----------------------------------------------------------
err() { printf "test_color_pipeline: %s\n" "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 2
  fi
}

require_cmd exiftool
require_cmd dd
require_cmd python3

if [[ ! -f "$COMPARE_PY" ]]; then
  err "compare_images.py not found at $COMPARE_PY"
  exit 2
fi

# Build maple-cli if missing. Honors caller-provided $MAPLE_CLI.
MAPLE_CLI="${MAPLE_CLI:-$MAPLE_CLI_RELEASE}"
if [[ ! -x "$MAPLE_CLI" ]]; then
  echo "test_color_pipeline: building maple-cli (release) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null )
  MAPLE_CLI="$MAPLE_CLI_RELEASE"
fi

# ----- discover fixtures ---------------------------------------------------
if [[ ! -d "$FIXTURES_DIR" ]]; then
  echo "test_color_pipeline: no test-fixtures/raws/ directory present — skipping"
  echo "test_color_pipeline: (gitignored fixtures; CI without fixtures is a soft pass)"
  exit 0
fi

# Collect top-level DNGs only (case-insensitive); deeper directories like
# pano_* contain multi-frame stitching inputs, not single-image parity cases.
shopt -s nullglob nocaseglob
FIXTURES=( "$FIXTURES_DIR"/*.dng )
shopt -u nocaseglob

if (( ${#FIXTURES[@]} == 0 )); then
  echo "test_color_pipeline: no DNG fixtures in $FIXTURES_DIR — skipping"
  echo "test_color_pipeline: (gitignored fixtures; CI without fixtures is a soft pass)"
  exit 0
fi

# ----- workspace -----------------------------------------------------------
WORKDIR="$(mktemp -d -t maple-color-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "test_color_pipeline: budgets — mean=$BUDGET p95=$BUDGET_P95 max=$BUDGET_MAX bias=$BUDGET_BIAS"
echo "test_color_pipeline: ${#FIXTURES[@]} fixture(s) in $FIXTURES_DIR"
echo ""

# ----- per-fixture loop ----------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

for raw in "${FIXTURES[@]}"; do
  stem="$(basename "$raw")"
  stem="${stem%.*}"
  ref_jpeg="$WORKDIR/$stem.preview.jpg"
  cand_png="$WORKDIR/$stem.candidate.png"
  cand_resized="$WORKDIR/$stem.candidate.resized.png"

  # All DNG photometric interpretations (CFA mosaic, LinearRaw) covered as of
  # ticket #07. BlackIsZero monochrome is rejected at decode by the Rust core
  # (Error::UnsupportedCfa) and produces a render failure, not a SKIP.

  # 0. Orientation gate. The harness compares Maple's *display-oriented*
  #    render against the *sensor-oriented* embedded JPEG preview. Fixtures
  #    with a non-Normal Orientation tag would need rotation before the
  #    Lanczos resize — without it the resize stretches a portrait image
  #    into a landscape aspect, producing huge per-pixel ΔE that's pure
  #    geometry noise, not pipeline noise. We skip these rather than
  #    invent an orientation-undo step that would mask real pipeline drift
  #    on landscape fixtures. See ticket #07 follow-up.
  orientation="$(exiftool -s -s -s -Orientation "$raw" 2>/dev/null || true)"
  if [[ -n "$orientation" && "$orientation" != "Horizontal (normal)" ]]; then
    printf "SKIP %-45s orientation=%s (sensor-vs-display mismatch)\n" "$stem" "$orientation"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  # 1. Read embedded preview offset/length.
  preview_meta="$(exiftool -PreviewImageStart -PreviewImageLength -s -s -s -n "$raw" 2>/dev/null || true)"
  preview_start="$(printf "%s\n" "$preview_meta" | sed -n '1p')"
  preview_len="$(printf "%s\n" "$preview_meta" | sed -n '2p')"
  if [[ -z "${preview_start:-}" || -z "${preview_len:-}" || "$preview_start" == "0" || "$preview_len" == "0" ]]; then
    printf "SKIP %-45s no embedded preview metadata\n" "$stem"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  # 2. Extract the embedded JPEG via dd. macOS dd with a regular-file input
  #    lseeks on `skip=`, so a multi-MB offset is fast enough even at bs=1
  #    (the 33 MB offset on test_0017.dng measured ~0.6 s).
  if ! dd if="$raw" of="$ref_jpeg" bs=1 skip="$preview_start" count="$preview_len" status=none 2>/dev/null; then
    printf "SKIP %-45s dd extraction failed\n" "$stem"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi
  actual_len="$(wc -c < "$ref_jpeg" | tr -d ' ')"
  if [[ "$actual_len" != "$preview_len" ]]; then
    printf "SKIP %-45s preview length mismatch (got %s, want %s)\n" "$stem" "$actual_len" "$preview_len"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  # 3. Render the candidate.
  if ! "$MAPLE_CLI" render "$raw" --out "$cand_png" >/dev/null 2>"$WORKDIR/$stem.render.err"; then
    printf "FAIL %-45s render failed (see %s)\n" "$stem" "$WORKDIR/$stem.render.err"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # 4. Resize candidate to the reference's dimensions. compare_images.py
  #    requires identical shapes; the embedded preview is downsampled.
  if ! python3 - "$cand_png" "$ref_jpeg" "$cand_resized" <<'PY' 2>"$WORKDIR/$stem.resize.err"
import sys
from PIL import Image
cand = Image.open(sys.argv[1]).convert("RGB")
ref  = Image.open(sys.argv[2]).convert("RGB")
if cand.size == ref.size:
    cand.save(sys.argv[3])
else:
    cand.resize(ref.size, Image.LANCZOS).save(sys.argv[3])
PY
  then
    printf "FAIL %-45s resize failed (see %s)\n" "$stem" "$WORKDIR/$stem.resize.err"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # 5. Diff.
  if ! diff_json="$(python3 "$COMPARE_PY" "$cand_resized" "$ref_jpeg" 2>"$WORKDIR/$stem.diff.err")"; then
    printf "FAIL %-45s compare_images.py errored (see %s)\n" "$stem" "$WORKDIR/$stem.diff.err"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # 6. Parse + budget-check (single python pass, prints decision line and
  #    returns 0 on PASS / 1 on FAIL). Use `set +e` locally so the pipeline
  #    stays in script even when this fixture fails.
  set +e
  status_line="$(python3 - "$diff_json" "$BUDGET" "$BUDGET_P95" "$BUDGET_MAX" "$BUDGET_BIAS" "$stem" <<'PY'
import json, sys
js, b_mean, b_p95, b_max, b_bias, stem = sys.argv[1:7]
b_mean = float(b_mean); b_p95 = float(b_p95); b_max = float(b_max); b_bias = float(b_bias)
d = json.loads(js)
if "error" in d:
    print(f"FAIL {stem:<45s} {d['error']}")
    sys.exit(1)
mean   = d["mean_deltaE"]
p95    = d["p95_deltaE"]
mx     = d["max_deltaE"]
br, bg, bb = d["bias_r"], d["bias_g"], d["bias_b"]
fails = []
if mean > b_mean: fails.append(f"mean {mean:.2f}>{b_mean:g}")
if p95  > b_p95:  fails.append(f"p95 {p95:.2f}>{b_p95:g}")
if mx   > b_max:  fails.append(f"max {mx:.2f}>{b_max:g}")
for n, v in (("R", br), ("G", bg), ("B", bb)):
    if abs(v) > b_bias: fails.append(f"bias_{n} {v:+.3f}>{b_bias:g}")
verdict = "PASS" if not fails else "FAIL"
detail = f"mean={mean:5.2f} p95={p95:5.2f} max={mx:5.2f} bias=({br:+.3f},{bg:+.3f},{bb:+.3f})"
extra  = "" if not fails else "  failures: " + ", ".join(fails)
print(f"{verdict} {stem:<45s} {detail}{extra}")
sys.exit(0 if not fails else 1)
PY
  )"
  rc=$?
  set -e

  echo "$status_line"
  if (( rc == 0 )); then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

# ----- summary -------------------------------------------------------------
echo ""
echo "test_color_pipeline: $PASS_COUNT pass, $FAIL_COUNT fail, $SKIP_COUNT skip"
if (( FAIL_COUNT > 0 )); then
  exit 1
fi
exit 0
