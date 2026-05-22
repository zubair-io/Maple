#!/usr/bin/env bash
# test_hue_stability.sh — hue-stability detector across exposure.
#
# Generates six saturated-primary patches (R, G, B, C, M, Y) at six
# exposures (-3, -1, 0, +1, +3, +5 EV) — 36 renders total — each with its
# own `MAPLE_STAGE_DUMP` subdir. Runs `hue_stability.py` against the
# resulting per-primary trees.
#
# Diagnostic, not a gate — exits 0 unless the build fails.
#
# Env overrides:
#   OUT_DIR    Working root for per-(primary, EV) dumps. Default: /tmp/maple-hue-*.
#   KEEP_TMP   Non-empty -> keep OUT_DIR after exit for inspection.
#   PRIMARIES  Space-separated list of primaries to sweep (default: "r g b c m y").
#   EVS        Space-separated list of EVs (default: "-3 -1 0 +1 +3 +5").
#   STAGE      Which stage's EXR to compare (default 16_agx).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PRIMARIES="${PRIMARIES:-r g b c m y}"
EVS="${EVS:--3 -1 0 +1 +3 +5}"
STAGE="${STAGE:-16_agx}"
KEEP_TMP="${KEEP_TMP:-}"

if [[ -n "${OUT_DIR:-}" ]]; then
  mkdir -p "$OUT_DIR"
  WORK="$OUT_DIR"
  CLEANUP=""
else
  WORK="$(mktemp -d -t maple-hue-XXXXXXXX)"
  CLEANUP="$WORK"
fi
cleanup() {
  if [[ -n "$CLEANUP" && -z "$KEEP_TMP" ]]; then
    rm -rf "$CLEANUP"
  fi
}
trap cleanup EXIT

DUMP_ROOT="$WORK/dumps"
mkdir -p "$DUMP_ROOT"

echo "# Building maple-cli with --features stage-dump..."
(
  cd "$REPO_ROOT/src/raw-pipeline"
  cargo build -p maple-cli --features stage-dump --release >/dev/null
)
MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

count=0
for prim in $PRIMARIES; do
  for ev in $EVS; do
    sub="$DUMP_ROOT/${prim}_${ev}"
    mkdir -p "$sub"
    # `--ev=-3` rather than `--ev -3` so clap doesn't read the leading
    # minus as a flag prefix.
    MAPLE_STAGE_DUMP="$sub" "$MAPLE_CLI" synthetic \
      --kind hue-patch \
      --primary "$prim" \
      "--ev=$ev" \
      --width 16 --height 16 \
      --out "$sub/patch.png"
    count=$((count + 1))
  done
done
echo "# Rendered $count primary×EV patches."
echo ""

python3 "$SCRIPT_DIR/hue_stability.py" "$DUMP_ROOT" \
  --stage "$STAGE" \
  --json "$WORK/hue_stability.json"

echo ""
echo "# Diagnostic outputs:"
echo "#   per-patch dumps: $DUMP_ROOT"
echo "#   JSON:            $WORK/hue_stability.json"
if [[ -n "$KEEP_TMP" ]]; then
  echo "# (kept on disk because KEEP_TMP is set)"
elif [[ -n "$CLEANUP" ]]; then
  echo "# (will be cleaned up on exit — re-run with KEEP_TMP=1 to inspect)"
fi
