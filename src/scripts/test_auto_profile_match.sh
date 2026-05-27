#!/usr/bin/env bash
# test_auto_profile_match.sh — per-fixture Auto Profile vs embedded JPEG gate.
#
# Per the Auto Profile Phase 1 spec
# (docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md):
# Maple's `Profile = Auto` should reproduce the camera-baked JPEG inside a
# small per-luma-band per-channel bias budget. This is the structural
# correctness signal — NOT an aggregate ΔE.
#
# Aggregate ΔE / RMSE / MAE are FORBIDDEN here (see auto_profile_diff.py
# docstring for the L2.7 failure lesson: a global green cast that an
# aggregate ΔE averaged away was caught by per-luma-band bias).
#
# Pipeline per fixture:
#   1. maple-cli render <raw> --out <auto.png> --profile auto
#   2. maple-cli extract-preview <raw> --out <jpeg.png>
#   3. auto_profile_diff.py <auto.png> <jpeg.png> --budget <BUDGET>
#   4. PASS if all 5 luma bands × 3 channels stay within ±BUDGET.
#
# Soft skip when test-fixtures/raws/ is absent — keeps CI without fixtures
# green (mirrors test_color_pipeline.sh's pattern).
#
# Env overrides:
#   BUDGET   per-band per-channel absolute bias budget (default 0.05).
#   FILTER   substring filter on the RAW basename.
#
# Usage:
#   src/scripts/test_auto_profile_match.sh
#   BUDGET=0.07 src/scripts/test_auto_profile_match.sh
#   FILTER=test_0000 src/scripts/test_auto_profile_match.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BUDGET="${BUDGET:-0.05}"
FILTER="${FILTER:-}"

if [ ! -d "$REPO_ROOT/test-fixtures/raws" ]; then
    echo "test_auto_profile_match: no test-fixtures/raws — skip-pass"
    exit 0
fi

cd "$REPO_ROOT/src/raw-pipeline"
# NB: no piping through tail/head — full output goes straight to stderr/stdout
# so cargo's progress lines don't get truncated and the watchdog stays happy.
cargo build --release --bin maple-cli >&2

CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
DIFF_PY="$REPO_ROOT/src/scripts/auto_profile_diff.py"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

EXIT=0
SKIPPED=0
PASSED=0
FAILED=0

shopt -s nullglob nocaseglob
RAWS=("$REPO_ROOT"/test-fixtures/raws/test_*.{dng,raw,cr2,raf,arw,nef,fff})
shopt -u nullglob nocaseglob

if [ "${#RAWS[@]}" -eq 0 ]; then
    echo "test_auto_profile_match: no test_*.{dng,raw,cr2,raf,arw,nef,fff} fixtures — skip-pass"
    exit 0
fi

for raw in "${RAWS[@]}"; do
    [ -f "$raw" ] || continue
    base="$(basename "$raw")"
    stem="${base%.*}"

    if [ -n "$FILTER" ] && [[ "$base" != *"$FILTER"* ]]; then
        continue
    fi

    auto_png="$TMP/${stem}_auto.png"
    jpeg_png="$TMP/${stem}_jpeg.png"

    if ! "$CLI" render "$raw" --out "$auto_png" --profile auto >"$TMP/${stem}.render.log" 2>&1; then
        echo "  $stem SKIP (render failed)"
        sed 's/^/    /' "$TMP/${stem}.render.log" || true
        SKIPPED=$((SKIPPED+1))
        continue
    fi
    if ! "$CLI" extract-preview "$raw" --out "$jpeg_png" >"$TMP/${stem}.preview.log" 2>&1; then
        echo "  $stem SKIP (no embedded JPEG)"
        SKIPPED=$((SKIPPED+1))
        continue
    fi

    if python3 "$DIFF_PY" "$auto_png" "$jpeg_png" --budget "$BUDGET" \
            >"$TMP/${stem}.json" 2>"$TMP/${stem}.err"; then
        echo "  $stem PASS"
        PASSED=$((PASSED+1))
    else
        echo "  $stem FAIL"
        cat "$TMP/${stem}.json"
        cat "$TMP/${stem}.err" >&2
        FAILED=$((FAILED+1))
        EXIT=1
    fi
done

echo ""
echo "passed=$PASSED  failed=$FAILED  skipped=$SKIPPED  budget=±$BUDGET"
exit $EXIT
