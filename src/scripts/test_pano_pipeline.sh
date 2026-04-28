#!/bin/bash
# test_pano_pipeline.sh — perceptual panorama-pipeline gate.
#
# Mirrors the structure of test_color_pipeline.sh (color parity harness)
# but exercises the panorama stitching pipeline instead of the raw render
# pipeline.
#
# For each fixture pair found under <repo-root>/test-fixtures/pano/corpus/:
#   1. Run `pano-smoke <a.png> <b.png> -o <candidate.png>`.
#   2. Diff the candidate against the corresponding reference in
#      test-fixtures/pano/references/ via compare_images.py (CIEDE2000 +
#      per-channel bias).
#   3. Compare each metric against its budget; exit non-zero on the first
#      failure.
#
# Reports mean ΔE₀₀, P95, max, and per-channel bias per fixture pair.
# A case passes only when all four metrics are under budget.
#
# CI gate: exits 0 if all present fixture pairs pass; non-zero if any fail.
#
# SKIP-PASS CONTRACT
#   If the corpus directory is absent or contains no PNG files, this script
#   prints a "no fixtures, skipping" message and exits 0.  This mirrors the
#   behavior of test_color_pipeline.sh so that CI builds without pre-generated
#   fixtures do not fail spuriously.
#
#   The synthetic fixtures can be generated locally with:
#     pano-smoke --gen-fixtures <repo-root>/test-fixtures/pano/
#   or by running this script with --gen-fixtures first:
#     src/scripts/test_pano_pipeline.sh --gen-fixtures
#
# FIXTURE NAMING CONVENTION
#   corpus/     — input PNG pairs, named <stem>_a.png and <stem>_b.png
#   references/ — reference PNG for each pair, named <stem>.png
#
#   Example:
#     corpus/synthetic_a.png + corpus/synthetic_b.png →
#     references/synthetic.png
#
# ENV OVERRIDES (same knobs as test_color_pipeline.sh)
#   BUDGET      = mean ΔE₀₀ threshold       (default 15)
#   BUDGET_P95  = P95  ΔE₀₀ threshold       (default 2 × BUDGET)
#   BUDGET_MAX  = max  ΔE₀₀ threshold       (default 4 × BUDGET)
#   BUDGET_BIAS = abs per-channel bias cap  (default 0.05)
#
# USAGE
#   src/scripts/test_pano_pipeline.sh                     # default budgets
#   BUDGET=5 src/scripts/test_pano_pipeline.sh            # tighten the mean gate
#   src/scripts/test_pano_pipeline.sh --gen-fixtures       # regenerate fixtures first
#   src/scripts/test_pano_pipeline.sh --max-delta-e 15    # explicit mean budget

set -euo pipefail

# ---------------------------------------------------------------------------
# Repo / path setup
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CORPUS_DIR="$REPO_ROOT/test-fixtures/pano/corpus"
REFS_DIR="$REPO_ROOT/test-fixtures/pano/references"
COMPARE_PY="$REPO_ROOT/src/scripts/compare_images.py"
PANO_SMOKE_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/pano-smoke"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
GEN_FIXTURES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gen-fixtures)
      GEN_FIXTURES=1
      shift
      ;;
    --max-delta-e)
      BUDGET="${2:-15}"
      shift 2
      ;;
    --p95)
      BUDGET_P95="${2:-}"
      shift 2
      ;;
    --max)
      BUDGET_MAX="${2:-}"
      shift 2
      ;;
    --bias)
      BUDGET_BIAS="${2:-0.05}"
      shift 2
      ;;
    *)
      echo "test_pano_pipeline: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Budgets (mirror test_color_pipeline.sh defaults)
# ---------------------------------------------------------------------------
BUDGET="${BUDGET:-15}"
BUDGET_P95="${BUDGET_P95:-$(awk -v b="$BUDGET" 'BEGIN { printf "%g", b * 2 }')}"
BUDGET_MAX="${BUDGET_MAX:-$(awk -v b="$BUDGET" 'BEGIN { printf "%g", b * 4 }')}"
BUDGET_BIAS="${BUDGET_BIAS:-0.05}"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
err() { printf "test_pano_pipeline: %s\n" "$*" >&2; }

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

# ---------------------------------------------------------------------------
# Build pano-smoke if needed
# ---------------------------------------------------------------------------
PANO_SMOKE="${PANO_SMOKE:-$PANO_SMOKE_RELEASE}"
if [[ ! -x "$PANO_SMOKE" ]]; then
  echo "test_pano_pipeline: building pano-smoke (release) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin pano-smoke >/dev/null 2>&1 )
  PANO_SMOKE="$PANO_SMOKE_RELEASE"
fi

# ---------------------------------------------------------------------------
# Optionally regenerate fixtures
# ---------------------------------------------------------------------------
if [[ "$GEN_FIXTURES" -eq 1 ]]; then
  echo "test_pano_pipeline: generating synthetic fixtures ..."
  "$PANO_SMOKE" --gen-fixtures "$REPO_ROOT/test-fixtures/pano" >/dev/null
  echo "test_pano_pipeline: fixtures written to $REPO_ROOT/test-fixtures/pano/"
fi

# ---------------------------------------------------------------------------
# Discover fixture pairs
# ---------------------------------------------------------------------------
# Each pair is identified by a stem: corpus/<stem>_a.png + corpus/<stem>_b.png
# → references/<stem>.png.

if [[ ! -d "$CORPUS_DIR" ]]; then
  echo "test_pano_pipeline: no test-fixtures/pano/corpus/ directory present — skipping"
  echo "test_pano_pipeline: (generate fixtures via: $0 --gen-fixtures)"
  echo "test_pano_pipeline: (gitignored fixtures; CI without fixtures is a soft pass)"
  exit 0
fi

# Collect _a.png files to find pair stems.
shopt -s nullglob
A_FILES=( "$CORPUS_DIR"/*_a.png )
shopt -u nullglob

if (( ${#A_FILES[@]} == 0 )); then
  echo "test_pano_pipeline: no *_a.png fixture pairs in $CORPUS_DIR — skipping"
  echo "test_pano_pipeline: (generate fixtures via: $0 --gen-fixtures)"
  echo "test_pano_pipeline: (gitignored fixtures; CI without fixtures is a soft pass)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------
WORKDIR="$(mktemp -d -t maple-pano-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "test_pano_pipeline: budgets — mean=$BUDGET p95=$BUDGET_P95 max=$BUDGET_MAX bias=$BUDGET_BIAS"
echo "test_pano_pipeline: ${#A_FILES[@]} fixture pair(s) in $CORPUS_DIR"
echo ""

# ---------------------------------------------------------------------------
# Per-pair loop
# ---------------------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

for a_file in "${A_FILES[@]}"; do
  # Derive the stem (remove trailing _a.png) and the b / reference paths.
  stem_full="$(basename "$a_file")"
  stem="${stem_full%_a.png}"

  b_file="$CORPUS_DIR/${stem}_b.png"
  ref_file="$REFS_DIR/${stem}.png"
  cand_png="$WORKDIR/${stem}.candidate.png"

  # Check b input exists.
  if [[ ! -f "$b_file" ]]; then
    printf "SKIP %-45s missing b input: %s\n" "$stem" "$b_file"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  # Check reference exists.
  if [[ ! -f "$ref_file" ]]; then
    printf "SKIP %-45s missing reference: %s\n" "$stem" "$ref_file"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  # Stitch.
  if ! "$PANO_SMOKE" "$a_file" "$b_file" -o "$cand_png" \
       >"$WORKDIR/${stem}.stitch.stdout" \
       2>"$WORKDIR/${stem}.stitch.stderr"; then
    printf "FAIL %-45s stitch failed (see %s)\n" "$stem" "$WORKDIR/${stem}.stitch.stderr"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # Resize candidate to match reference dimensions if needed.
  cand_resized="$WORKDIR/${stem}.candidate.resized.png"
  if ! python3 - "$cand_png" "$ref_file" "$cand_resized" <<'PY' 2>"$WORKDIR/${stem}.resize.err"
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
    printf "FAIL %-45s resize failed (see %s)\n" "$stem" "$WORKDIR/${stem}.resize.err"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # Diff.
  if ! diff_json="$(python3 "$COMPARE_PY" "$cand_resized" "$ref_file" 2>"$WORKDIR/${stem}.diff.err")"; then
    printf "FAIL %-45s compare_images.py errored (see %s)\n" "$stem" "$WORKDIR/${stem}.diff.err"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # Budget-check (mirrors test_color_pipeline.sh inline Python).
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

# ---------------------------------------------------------------------------
# pano_01 — 21-image DNG regression gate
#
# Separate from the synthetic fixture loop above.  The inputs are the raw
# DNG sequence from test-fixtures/raws/pano_01/ (gitignored).  The reference
# is the saved output from the first accepted stitch at
# test-fixtures/pano/references/pano_01_reference.png (also gitignored).
#
# Logic:
#   • Inputs absent  → silent skip (no message, no count change).
#   • Inputs present but reference absent → skip-pass with message.
#   • Both present   → stitch + diff against reference; gate on ΔE ≤ 30 first
#     cut (loose — regression only, not quality vs. ground truth).
#
# The ΔE 30 budget is intentionally loose: we're gating on pipeline
# regression, not perceptual quality vs. an external reference.
# ---------------------------------------------------------------------------
PANO01_DIR="${PANO01_DIR:-$REPO_ROOT/test-fixtures/raws/pano_01}"
PANO01_REF="$REFS_DIR/pano_01_reference.png"
PANO01_BUDGET="${PANO01_BUDGET:-30}"
PANO01_BUDGET_P95="$(awk -v b="$PANO01_BUDGET" 'BEGIN { printf "%g", b * 2 }')"
PANO01_BUDGET_MAX="$(awk -v b="$PANO01_BUDGET" 'BEGIN { printf "%g", b * 4 }')"
PANO01_BUDGET_BIAS="${PANO01_BUDGET_BIAS:-0.20}"

if [[ -f "$PANO01_DIR/PANO0001.DNG" ]]; then
  if [[ ! -f "$PANO01_REF" ]]; then
    echo "test_pano_pipeline: pano_01 inputs present but no reference at $PANO01_REF — skipping"
    echo "test_pano_pipeline: (generate reference via: pano-smoke --projection spherical <inputs> -o pano_01_full.png)"
    echo "test_pano_pipeline: (then: mkdir -p $REFS_DIR && cp pano_01_full.png $PANO01_REF)"
    SKIP_COUNT=$((SKIP_COUNT + 1))
  else
    echo "test_pano_pipeline: pano_01 — 21-image regression run (budget mean≤$PANO01_BUDGET bias≤$PANO01_BUDGET_BIAS)"

    # Build input array.
    PANO01_INPUTS=()
    for _i in $(seq -f "%04g" 1 21); do
      PANO01_INPUTS+=("$PANO01_DIR/PANO${_i}.DNG")
    done

    PANO01_CAND="$WORKDIR/pano_01.candidate.png"

    # Stitch.
    if ! "$PANO_SMOKE" --projection spherical "${PANO01_INPUTS[@]}" -o "$PANO01_CAND" \
         >"$WORKDIR/pano_01.stitch.stdout" \
         2>"$WORKDIR/pano_01.stitch.stderr"; then
      printf "FAIL %-45s pano_01 stitch failed (see %s)\n" "pano_01" "$WORKDIR/pano_01.stitch.stderr"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    else
      # Resize candidate to match reference dimensions if needed.
      PANO01_RESIZED="$WORKDIR/pano_01.candidate.resized.png"
      if ! python3 - "$PANO01_CAND" "$PANO01_REF" "$PANO01_RESIZED" <<'PY' 2>"$WORKDIR/pano_01.resize.err"
from PIL import Image
import sys
cand = Image.open(sys.argv[1]).convert("RGB")
ref  = Image.open(sys.argv[2]).convert("RGB")
if cand.size == ref.size:
    cand.save(sys.argv[3])
else:
    cand.resize(ref.size, Image.LANCZOS).save(sys.argv[3])
PY
      then
        printf "FAIL %-45s pano_01 resize failed (see %s)\n" "pano_01" "$WORKDIR/pano_01.resize.err"
        FAIL_COUNT=$((FAIL_COUNT + 1))
      else
        # Diff.
        if ! pano01_diff_json="$(python3 "$COMPARE_PY" "$PANO01_RESIZED" "$PANO01_REF" 2>"$WORKDIR/pano_01.diff.err")"; then
          printf "FAIL %-45s pano_01 compare_images.py errored (see %s)\n" "pano_01" "$WORKDIR/pano_01.diff.err"
          FAIL_COUNT=$((FAIL_COUNT + 1))
        else
          # Budget-check.
          set +e
          pano01_status_line="$(python3 - "$pano01_diff_json" "$PANO01_BUDGET" "$PANO01_BUDGET_P95" "$PANO01_BUDGET_MAX" "$PANO01_BUDGET_BIAS" "pano_01" <<'PY'
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
          pano01_rc=$?
          set -e

          echo "$pano01_status_line"
          if (( pano01_rc == 0 )); then
            PASS_COUNT=$((PASS_COUNT + 1))
          else
            FAIL_COUNT=$((FAIL_COUNT + 1))
          fi
        fi
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "test_pano_pipeline: $PASS_COUNT pass, $FAIL_COUNT fail, $SKIP_COUNT skip"
if (( FAIL_COUNT > 0 )); then
  exit 1
fi
exit 0
