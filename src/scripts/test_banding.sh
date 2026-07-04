#!/usr/bin/env bash
# test_banding.sh — second-difference banding GATE (#1627).
#
# Sibling of test_synthetic_grey.sh / test_grey_adjustments.sh: inputs are
# synthesised in-memory (no test-fixtures/raws/ needed), so this script
# NEVER skip-passes — it always builds, always renders, always gates.
#
# Sweeps:
#   * Fixtures: a neutral 0->1 luma ramp, plus constant-L/constant-hue Oklab
#     chroma ramps at four named hues (foliage yellow-green, blue, magenta,
#     skin) — see `raw_core::synthetic_input::{neutral_ramp,chroma_ramp}`.
#   * Slider-extreme cases: baseline (all-default), exposure +4 EV,
#     contrast +100, shadows +100, blacks -100, saturation +100, vibrance
#     +100 (the #1621-class axis) — via `maple-cli synthetic --params <xmp>`.
#   * Stages: 16_agx (AgX post-outset Oklab gamut compress) AND
#     17_srgb_linear (the Rec.2020->sRGB display-encode Oklab gamut
#     compress) — the #1627 scope addition (#1621 fixed both call sites of
#     `compress_to_unit_cube_oklab`; either can regress independently).
#
# Metric: `banding_check.py`'s second-difference spike (see that file's
# module doc for why second difference, not first-difference monotonicity).
# Budgets are read from test-fixtures/banding_budgets.json — a one-way
# ratchet derived via a RED run (tools/budget_init.py pattern): observed
# worst-case + 5-10% headroom, never an invented round number. Re-derive by
# deleting the JSON's entries, running with BUDGET_INIT=1 (prints the
# derived table instead of gating), and pasting the result back in.
#
# Env overrides:
#   OUT_DIR      Working root. Default: /tmp/maple-banding-*.
#   KEEP_TMP     Non-empty -> keep OUT_DIR after exit for inspection.
#   WIDTH        Ramp width in pixels (default 1024).
#   HEIGHT       Ramp height in pixels (default 8).
#   BUDGETS      Override path to the budgets JSON.
#   BUDGET_INIT  Non-empty -> print derived ceilings instead of gating
#                (still exits 0; use to regenerate banding_budgets.json).
#
# Companion to:
#   * `test_color_pipeline.sh`   — end-to-end ΔE gate vs ACR references.
#   * `test_synthetic_grey.sh` / `test_grey_adjustments.sh` — grey-card gates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-8}"
KEEP_TMP="${KEEP_TMP:-}"
BUDGETS="${BUDGETS:-$REPO_ROOT/test-fixtures/banding_budgets.json}"
BUDGET_INIT="${BUDGET_INIT:-}"

if [[ -n "${OUT_DIR:-}" ]]; then
  mkdir -p "$OUT_DIR"
  WORK="$OUT_DIR"
  CLEANUP=""
else
  WORK="$(mktemp -d -t maple-banding-XXXXXXXX)"
  CLEANUP="$WORK"
fi
cleanup() {
  if [[ -n "$CLEANUP" && -z "$KEEP_TMP" ]]; then
    rm -rf "$CLEANUP"
  fi
}
trap cleanup EXIT

echo "# Building maple-cli with --features stage-dump..."
(
  cd "$REPO_ROOT/src/raw-pipeline"
  cargo build -p maple-cli --features stage-dump --release >/dev/null
)
MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

# ----- slider-extreme XMP fixtures -----------------------------------------
# Minimal sidecars — only the field under test deviates from default. Every
# case runs through `render_from_scene_linear_with_chain` (scene_tone_controls
# + vibrance + saturation + ... + agx + display-encode), so exposure/
# shadows/blacks (scene_tone_controls), contrast (agx), and saturation/
# vibrance all take effect.
mkdir -p "$WORK/xmp"
cat > "$WORK/xmp/baseline.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/exposure_p4.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Exposure2012="+4.0"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/contrast_p100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Contrast2012="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/shadows_p100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Shadows2012="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/blacks_m100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Blacks2012="-100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/saturation_p100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Saturation="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
cat > "$WORK/xmp/vibrance_p100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:Vibrance="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF
# HSL 8-band saturation, all bands +100 (#1733 clamp-audit fix — hsl.rs's
# per-band SAT chroma scale gained the same gamut soft-knee as
# saturation.rs/vibrance.rs; this case locks the fix in against regression).
cat > "$WORK/xmp/hsl_saturation_p100.xmp" <<'EOF'
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                     crs:SaturationAdjustmentRed="+100"
                     crs:SaturationAdjustmentOrange="+100"
                     crs:SaturationAdjustmentYellow="+100"
                     crs:SaturationAdjustmentGreen="+100"
                     crs:SaturationAdjustmentAqua="+100"
                     crs:SaturationAdjustmentBlue="+100"
                     crs:SaturationAdjustmentPurple="+100"
                     crs:SaturationAdjustmentMagenta="+100"/>
  </rdf:RDF>
</x:xmpmeta>
EOF

CASES=(baseline exposure_p4 contrast_p100 shadows_p100 blacks_m100 saturation_p100 vibrance_p100 hsl_saturation_p100)
HUES=(foliage blue magenta skin)
STAGES=(16_agx 17_srgb_linear)

FAIL=0
INIT_ROWS=()

run_case() {
  local fixture="$1" kind="$2" hue_arg="$3" case="$4"
  local dump="$WORK/dumps_${fixture}_${case}"
  mkdir -p "$dump"
  local cli_args=(synthetic --kind "$kind" --width "$WIDTH" --height "$HEIGHT" \
    --params "$WORK/xmp/${case}.xmp" --out "$WORK/ramp_${fixture}_${case}.png")
  if [[ -n "$hue_arg" ]]; then
    cli_args+=(--hue "$hue_arg")
  fi
  if ! MAPLE_STAGE_DUMP="$dump" "$MAPLE_CLI" "${cli_args[@]}" >"$WORK/cli_${fixture}_${case}.log" 2>&1; then
    echo "test_banding: ERROR — maple-cli failed for $fixture/$case" >&2
    cat "$WORK/cli_${fixture}_${case}.log" >&2
    FAIL=1
    return
  fi

  local axis="chroma"
  [[ "$fixture" == "neutral" ]] && axis="luma"

  for stage in "${STAGES[@]}"; do
    local json_out="$WORK/result_${fixture}_${case}_${stage}.json"
    local budget_key="${fixture}/${stage}/${axis}"
    local py_args=("$SCRIPT_DIR/banding_check.py" "$dump" --stage "$stage" \
      --ramp-axis "$axis" --json "$json_out" --budgets "$BUDGETS" \
      --budget-key "$budget_key")
    if [[ -z "$BUDGET_INIT" ]]; then
      py_args+=(--require-budget)
    fi
    local py_status=0
    python3 "${py_args[@]}" > "$WORK/log_${fixture}_${case}_${stage}.txt" 2>&1 || py_status=$?
    if [[ "$py_status" -ne 0 ]]; then
      if [[ -z "$BUDGET_INIT" ]]; then
        echo "## FAIL: $budget_key (case=$case)"
        cat "$WORK/log_${fixture}_${case}_${stage}.txt"
        FAIL=1
      else
        # BUDGET_INIT mode doesn't pass --require-budget, so a failure here
        # is a real error (crash, malformed dump, etc.), not a missing
        # budget entry. Surface it and skip this case instead of reading a
        # missing/stale $json_out, which would mask the real failure behind
        # a secondary "file not found" / JSON-decode error.
        echo "## BUDGET_INIT ERROR: $budget_key (case=$case) — banding_check.py failed"
        cat "$WORK/log_${fixture}_${case}_${stage}.txt"
        FAIL=1
      fi
      continue
    fi
    if [[ -n "$BUDGET_INIT" ]]; then
      local d2 ratio
      d2=$(python3 -c "import json;print(json.load(open('$json_out'))['second_difference']['max_abs_d2'])")
      ratio=$(python3 -c "import json;print(json.load(open('$json_out'))['second_difference']['max_spike_ratio'])")
      INIT_ROWS+=("$budget_key $d2 $ratio")
    fi
  done
}

echo "# Sweeping neutral ramp (luma axis) across ${#CASES[@]} slider-extreme cases..."
for case in "${CASES[@]}"; do
  run_case "neutral" "neutral-ramp" "" "$case"
done

for hue in "${HUES[@]}"; do
  echo "# Sweeping chroma ramp hue=$hue across ${#CASES[@]} slider-extreme cases..."
  for case in "${CASES[@]}"; do
    run_case "$hue" "chroma-ramp" "$hue" "$case"
  done
done

if [[ -n "$BUDGET_INIT" ]]; then
  echo ""
  echo "# BUDGET_INIT — worst-case per (fixture/stage/axis) across the sweep,"
  echo "# +8% headroom on max_spike_ratio (floor 1.2), +10% on max_abs_d2 (floor 0.001):"
  echo ""
  python3 - "${INIT_ROWS[@]}" <<'PYEOF'
import sys
from collections import defaultdict

worst = defaultdict(lambda: (0.0, 0.0))
for row in sys.argv[1:]:
    key, d2, ratio = row.split()
    d2, ratio = float(d2), float(ratio)
    w_d2, w_ratio = worst[key]
    worst[key] = (max(w_d2, d2), max(w_ratio, ratio))

for key in sorted(worst):
    w_d2, w_ratio = worst[key]
    budget_d2 = max(round(w_d2 * 1.10, 6), 0.001)
    budget_ratio = max(round(w_ratio * 1.08, 3), 1.2)
    print(f'    "{key}": {{ "max_abs_d2": {budget_d2}, "max_spike_ratio": {budget_ratio} }},')
PYEOF
  echo ""
  echo "# (BUDGET_INIT run — not gated. Paste the table above into"
  echo "#  test-fixtures/banding_budgets.json, then re-run without BUDGET_INIT.)"
  exit 0
fi

echo ""
if [[ "$FAIL" -ne 0 ]]; then
  echo "test_banding: FAIL — one or more second-difference spike budgets breached" >&2
  echo "outputs kept at: $WORK (re-run with KEEP_TMP=1 to inspect after normal exit)" >&2
  exit 1
fi

echo "# PASS — all fixtures within their second-difference spike budgets."
if [[ -n "$KEEP_TMP" ]]; then
  echo "# (kept on disk at $WORK because KEEP_TMP is set)"
fi
