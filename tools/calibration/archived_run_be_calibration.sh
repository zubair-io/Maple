#!/bin/bash
# archived_run_be_calibration.sh — ARCHIVED, see ticket #370.
#
# Driver for the now-archived archived_derive_baseline_exposure.py. The
# per-body BaselineExposure lookup it populated was removed in #370 as
# the wrong architectural layer for aesthetic alignment (see docs/spec/
# 03-algorithms.md § "Look presets" / `view::look` in #371). Retained as
# historical reference only — not part of the active calibration loop.
#
# Drives archived_derive_baseline_exposure.py against the 11 vendor-RAW
# fixtures (CR2, ARW, RAF, NEF, X3F, fff, RAW). Skips the 7 DNG fixtures
# (their BaselineExposure tag is the canonical source).
#
# Output: a single-line JSON-per-fixture stream to stdout, plus a
# human-readable proposal table to stderr. Saves the full proposal at
# /tmp/be-proposals.json.
#
# Env overrides:
#   EV_STEP   — passed to the tool's --ev-step (default 0.1; use 0.5
#               for fast smoke runs)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL="$REPO_ROOT/tools/calibration/archived_derive_baseline_exposure.py"
RAWS_DIR="$REPO_ROOT/test-fixtures/raws"
REFS_DIR="$REPO_ROOT/test-fixtures/references"
OUT="/tmp/be-proposals.json"
EV_STEP="${EV_STEP:-0.1}"

# 11 vendor-RAW fixtures present in the set. test_0008 (.RAF) is the
# unsupported-CFA fixture and test_0016 (.X3F) is the corrupt fixture;
# the script soft-skips those when render fails.
VENDOR_RAWS=(
  test_0001.RAW test_0003.CR2 test_0004.fff test_0005.RAF test_0008.RAF
  test_0009.CR2 test_0010.CR2 test_0011.ARW test_0012.raf test_0014.NEF
  test_0016.X3F
)

: > "$OUT"

printf "%-9s  %-8s  %-9s  %-8s  %-8s  %-8s  %-7s\n" \
  "stem" "best_ev" "bias_max" "bias_r" "bias_g" "bias_b" "mean_de" >&2
printf "%-9s  %-8s  %-9s  %-8s  %-8s  %-8s  %-7s\n" \
  "--------" "--------" "---------" "--------" "--------" "--------" "-------" >&2

for raw in "${VENDOR_RAWS[@]}"; do
  stem="${raw%.*}"
  fixture="$RAWS_DIR/$raw"
  ref="$REFS_DIR/$stem/down/baseline.png"
  if [[ ! -f "$fixture" ]]; then
    printf "%-9s  SKIP (no fixture)\n" "$stem" >&2
    continue
  fi
  if [[ ! -f "$ref" ]]; then
    printf "%-9s  SKIP (no reference)\n" "$stem" >&2
    continue
  fi
  json="$("$TOOL" "$fixture" "$ref" --ev-step "$EV_STEP" 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    printf "%-9s  FAIL (sweep produced no output)\n" "$stem" >&2
    continue
  fi
  echo "$json" >> "$OUT"
  python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(f\"{sys.argv[2]:<9}  {d['best_ev']:+.2f}     {d['best_bias_max']:.4f}    {d['best_bias_r']:+.4f}  {d['best_bias_g']:+.4f}  {d['best_bias_b']:+.4f}  {d['best_mean_de']:6.2f}\")
" "$json" "$stem" >&2
done

echo "" >&2
echo "Full proposal saved to $OUT" >&2
