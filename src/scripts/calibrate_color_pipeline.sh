#!/bin/bash
# calibrate_color_pipeline.sh — color-calibration harness against ACR references.
#
# Sibling to test_color_pipeline.sh (which diffs vs the DNG's embedded JPEG
# preview as a sanity gate). This script diffs against the ACR-rendered
# references in test-fixtures/references/<stem>/{down,full}/<case>.png
# — the ground truth produced via the Photoshop ACR-batch script. Use
# this to (1) measure systematic per-channel bias across fixtures /
# slider cases, (2) tweak DCP / AgX / WB code, (3) re-run, and watch the
# numbers move.
#
# Pipeline per case in test-fixtures/references/manifest.json:
#   1. maple-cli batch <manifest> --out-dir <tmp>      (one shot, all cases)
#   2. For each ManifestCase whose ManifestOutput[resolution=down].png exists:
#      - Resize the candidate PNG to the reference's dimensions (Lanczos)
#      - python3 compare_images.py <cand_resized> <ref> → JSON
#      - Parse mean/p95/max ΔE + per-channel bias
#   3. Print column-aligned table sorted by fixture/case
#   4. Aggregate per-fixture and grand mean
#
# CI-style soft skip: missing test-fixtures/raws/, missing manifest, or
# manifest with zero matchable cases all exit 0 with a notice. Lets the
# script grow with the reference set as the user adds more fixtures.
#
# Env overrides:
#   MAPLE_CLI            override path to a pre-built maple-cli binary
#   MANIFEST             default test-fixtures/references/manifest.json
#   PREFERRED_RES        "down" (default) or "full"
#   FILTER               substring filter on case name (e.g. "wb_" or "test_0000")
#   KEEP_TMP             non-empty → leave the candidate dir on disk for inspection
#
# Usage:
#   src/scripts/calibrate_color_pipeline.sh
#   FILTER=test_0000 src/scripts/calibrate_color_pipeline.sh
#   FILTER=wb_ src/scripts/calibrate_color_pipeline.sh
#   PREFERRED_RES=full src/scripts/calibrate_color_pipeline.sh

set -euo pipefail

# ----- repo root -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MANIFEST="${MANIFEST:-$REPO_ROOT/test-fixtures/references/manifest.json}"
COMPARE_PY="$REPO_ROOT/src/scripts/compare_images.py"
MAPLE_CLI_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
PREFERRED_RES="${PREFERRED_RES:-down}"
FILTER="${FILTER:-}"

# ----- preflight -----------------------------------------------------------
err() { printf "calibrate_color: %s\n" "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 2
  fi
}

require_cmd python3

if [[ ! -f "$COMPARE_PY" ]]; then
  err "compare_images.py not found at $COMPARE_PY"
  exit 2
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "calibrate_color: manifest not found at $MANIFEST — skipping"
  echo "calibrate_color: (gitignored references; CI without references is a soft pass)"
  exit 0
fi

# Build maple-cli if missing. Honors caller-provided $MAPLE_CLI.
MAPLE_CLI="${MAPLE_CLI:-$MAPLE_CLI_RELEASE}"
if [[ ! -x "$MAPLE_CLI" ]]; then
  echo "calibrate_color: building maple-cli (release) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null )
  MAPLE_CLI="$MAPLE_CLI_RELEASE"
fi

# ----- workspace -----------------------------------------------------------
WORKDIR="$(mktemp -d -t maple-calibrate-XXXXXX)"
if [[ -z "${KEEP_TMP:-}" ]]; then
  trap 'rm -rf "$WORKDIR"' EXIT
else
  echo "calibrate_color: KEEP_TMP set — candidates in $WORKDIR"
fi

CANDIDATES_DIR="$WORKDIR/candidates"
mkdir -p "$CANDIDATES_DIR"

echo "calibrate_color: manifest=$MANIFEST"
echo "calibrate_color: preferred_resolution=$PREFERRED_RES"
[[ -n "$FILTER" ]] && echo "calibrate_color: filter=$FILTER"
echo ""

# ----- 1. Render all cases via maple-cli batch -----------------------------
# `maple-cli batch` writes <out_dir>/<name.replace('/', '_')>.png per case.
# Filter is applied substring-on-case-name (matches the Rust `--cases-filter`
# arg) so partial-fixture iteration is fast.
echo "calibrate_color: rendering candidates ..."
batch_args=( batch --manifest "$MANIFEST" --out-dir "$CANDIDATES_DIR" )
if [[ -n "$FILTER" ]]; then
  batch_args+=( --cases-filter "$FILTER" )
fi
# maple-cli batch returns non-zero if ANY case fails (e.g. unsupported X3F).
# That's expected with a heterogeneous fixture set — don't abort the script.
"$MAPLE_CLI" "${batch_args[@]}" 2>&1 | sed 's/^/  /' || true
echo ""

# ----- 2. Walk manifest, diff each case vs its reference -------------------
# Single python invocation that reads manifest.json, diffs each candidate vs
# its expected reference (PREFERRED_RES first, falling back to whatever
# resolution exists), and prints two outputs:
#   * a tab-separated per-case row to stdout
#   * a one-line JSON summary on the LAST line (fixture/case rollups +
#     grand mean) so callers can grep it for CI assertions.
python3 - "$MANIFEST" "$CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" <<'PY'
import json
import os
import sys
from collections import defaultdict
from typing import Optional

import numpy as np
from PIL import Image
import colour
# 4000x2667 (down) and 12288x8192 (full) ACR refs trip Pillow's
# decompression-bomb heuristic. They're our ground truth; suppress.
Image.MAX_IMAGE_PIXELS = None

manifest_path, cand_dir, compare_py, preferred_res, name_filter = sys.argv[1:6]


def diff_inline(cand_path: str, ref_path: str) -> dict:
    """Inline equivalent of compare_images.py main(). Avoids subprocess
    + numpy/colour-science re-import overhead per case (was 1-2s/case ×
    688 = 15+ min — this version is ~50ms each)."""
    cand_img = Image.open(cand_path).convert("RGB")
    ref_img = Image.open(ref_path).convert("RGB")
    if cand_img.size != ref_img.size:
        cand_img = cand_img.resize(ref_img.size, Image.LANCZOS)
    cand = np.asarray(cand_img, dtype=np.float32) / 255.0
    ref = np.asarray(ref_img, dtype=np.float32) / 255.0
    cand_xyz = colour.sRGB_to_XYZ(cand)
    ref_xyz = colour.sRGB_to_XYZ(ref)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab = colour.XYZ_to_Lab(ref_xyz)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    bias = (cand - ref).mean(axis=(0, 1))
    return {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE": float(np.percentile(dE, 95)),
        "max_deltaE": float(np.max(dE)),
        "bias_r": float(bias[0]),
        "bias_g": float(bias[1]),
        "bias_b": float(bias[2]),
        "n_pixels": int(cand.shape[0] * cand.shape[1]),
    }

with open(manifest_path) as f:
    manifest = json.load(f)

cases = manifest.get("cases", [])
if name_filter:
    cases = [c for c in cases if name_filter in c["name"]]

# Header — column widths chosen so test_NNNN/<case>_max fits.
print(f"{'fixture':<12} {'case':<22} {'n_pix':>9}  "
      f"{'mean':>6} {'p95':>6} {'max':>6}  "
      f"{'bR':>8} {'bG':>8} {'bB':>8}")
print("-" * 96)

def pick_reference(outputs: list[dict]) -> Optional[dict]:
    """Strict: only use PREFERRED_RES. Falling back to `full` (typically
    12288x8192) blows the per-case diff time from ~50ms to ~10s. Cases
    that lack the preferred resolution are skipped."""
    by_res = {o["resolution"]: o for o in outputs}
    if preferred_res in by_res and os.path.exists(by_res[preferred_res]["png"]):
        return by_res[preferred_res]
    return None

per_fixture: dict[str, list[dict]] = defaultdict(list)
all_rows: list[dict] = []
skipped_no_ref = 0
skipped_no_cand = 0
skipped_no_raw = 0
errors = 0

for case in sorted(cases, key=lambda c: c["name"]):
    name = case["name"]
    fixture, case_label = (name.split("/", 1) + [""])[:2]

    # Skip if RAW missing — maple-cli batch will already have errored
    # but we want to surface the skip cleanly.
    if not os.path.exists(case["raw"]):
        skipped_no_raw += 1
        continue

    flat = name.replace("/", "_")
    cand_path = os.path.join(cand_dir, f"{flat}.png")
    if not os.path.exists(cand_path):
        skipped_no_cand += 1
        continue

    ref = pick_reference(case.get("outputs", []))
    if ref is None:
        skipped_no_ref += 1
        continue
    ref_path = ref["png"]

    try:
        metrics = diff_inline(cand_path, ref_path)
    except Exception as e:
        print(f"{fixture:<12} {case_label:<22} {'DIFF':>9}  diff failed: {e}",
              file=sys.stderr)
        errors += 1
        continue

    row = {
        "fixture": fixture,
        "case": case_label,
        "n_pixels": metrics["n_pixels"],
        "mean": metrics["mean_deltaE"],
        "p95": metrics["p95_deltaE"],
        "max": metrics["max_deltaE"],
        "bR": metrics["bias_r"],
        "bG": metrics["bias_g"],
        "bB": metrics["bias_b"],
    }
    all_rows.append(row)
    per_fixture[fixture].append(row)

    # Tabular row.
    n_pix_str = f"{row['n_pixels'] / 1e6:5.2f}M" if row["n_pixels"] >= 1e6 else f"{row['n_pixels']:>8}"
    print(f"{fixture:<12} {case_label:<22} {n_pix_str:>9}  "
          f"{row['mean']:6.2f} {row['p95']:6.2f} {row['max']:6.2f}  "
          f"{row['bR']:+8.4f} {row['bG']:+8.4f} {row['bB']:+8.4f}")

# Per-fixture aggregate.
print("-" * 96)
for fixture in sorted(per_fixture.keys()):
    rows = per_fixture[fixture]
    if not rows:
        continue
    n = len(rows)
    mean_de = sum(r["mean"] for r in rows) / n
    mean_bR = sum(r["bR"] for r in rows) / n
    mean_bG = sum(r["bG"] for r in rows) / n
    mean_bB = sum(r["bB"] for r in rows) / n
    print(f"{fixture:<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{mean_de:6.2f} {'-':>6} {'-':>6}  "
          f"{mean_bR:+8.4f} {mean_bG:+8.4f} {mean_bB:+8.4f}")

# Grand aggregate.
if all_rows:
    n = len(all_rows)
    grand_mean = sum(r["mean"] for r in all_rows) / n
    grand_bR = sum(r["bR"] for r in all_rows) / n
    grand_bG = sum(r["bG"] for r in all_rows) / n
    grand_bB = sum(r["bB"] for r in all_rows) / n
    print("=" * 96)
    print(f"{'GRAND':<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{grand_mean:6.2f} {'-':>6} {'-':>6}  "
          f"{grand_bR:+8.4f} {grand_bG:+8.4f} {grand_bB:+8.4f}")
    print()
    print(f"# Reading the bias columns:")
    print(f"#   bR/bG/bB are mean (candidate - reference) per channel in [0,1] sRGB-encoded units.")
    print(f"#   Positive = Maple has too much of that channel. Negative = too little.")
    print(f"#   Systematic bias (same sign across all fixtures) -> a calibration target.")
    print(f"#   Cast that grows with exposure_max -> AgX gain. Only on wb_* -> WB delta logic.")
    print(f"#   Cast on baseline only -> DCP / forward-matrix.")

# Skip / error summary.
print(f"# stats: {len(all_rows)} compared, "
      f"{skipped_no_raw} skipped(no-raw), "
      f"{skipped_no_cand} skipped(no-candidate), "
      f"{skipped_no_ref} skipped(no-reference), "
      f"{errors} errors")

# One-line JSON summary on the very last line for CI scrapers.
summary = {
    "compared": len(all_rows),
    "skipped_no_raw": skipped_no_raw,
    "skipped_no_candidate": skipped_no_cand,
    "skipped_no_reference": skipped_no_ref,
    "errors": errors,
    "grand_mean_deltaE": (sum(r["mean"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_r": (sum(r["bR"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_g": (sum(r["bG"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_b": (sum(r["bB"] for r in all_rows) / len(all_rows)) if all_rows else None,
}
print(json.dumps(summary))

sys.exit(1 if errors > 0 else 0)
PY
