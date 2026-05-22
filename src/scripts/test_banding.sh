#!/usr/bin/env bash
# test_banding.sh — banding detector on a synthetic neutral ramp.
#
# Generates an in-Rust 0→1 ramp via `maple-cli synthetic --kind neutral-ramp`,
# dumps every pipeline stage to `MAPLE_STAGE_DUMP`, then runs
# `banding_check.py` against the post-AgX EXR.
#
# Diagnostic, not a gate — exits 0 unless the build fails.
#
# Env overrides:
#   OUT_DIR    Working dir for the dump / PNG. Default: /tmp/maple-banding-*.
#   KEEP_TMP   Non-empty -> keep OUT_DIR after exit for inspection.
#   WIDTH      Ramp width in pixels (default 1024).
#   HEIGHT     Ramp height in pixels (default 8).
#   STAGE      Which stage's EXR to scan (default 16_agx).
#
# Companion to:
#   * `test_color_pipeline.sh`   — end-to-end ΔE gate vs ACR references.
#   * `test_stage_diagnostic.sh` — per-stage stats on a real fixture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-8}"
STAGE="${STAGE:-16_agx}"
KEEP_TMP="${KEEP_TMP:-}"

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

DUMP_DIR="$WORK/stages"
mkdir -p "$DUMP_DIR"

echo "# Building maple-cli with --features stage-dump..."
(
  cd "$REPO_ROOT/src/raw-pipeline"
  cargo build -p maple-cli --features stage-dump --release >/dev/null
)
MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

echo "# Generating synthetic neutral ramp (${WIDTH}x${HEIGHT}) → $WORK/ramp.png"
MAPLE_STAGE_DUMP="$DUMP_DIR" "$MAPLE_CLI" synthetic \
  --kind neutral-ramp \
  --width "$WIDTH" --height "$HEIGHT" \
  --out "$WORK/ramp.png"

N_EXR=$(find "$DUMP_DIR" -name '*.exr' | wc -l | tr -d ' ')
if [[ "$N_EXR" -eq 0 ]]; then
  echo "test_banding: ERROR — no EXR files written to $DUMP_DIR" >&2
  echo "(likely the binary was built without the stage-dump feature)" >&2
  exit 1
fi
echo "# Wrote $N_EXR stage EXRs."
echo ""

python3 "$SCRIPT_DIR/banding_check.py" "$DUMP_DIR" \
  --stage "$STAGE" \
  --json "$WORK/banding.json"

echo ""
echo "# Diagnostic outputs:"
echo "#   stage EXRs: $DUMP_DIR"
echo "#   JSON:       $WORK/banding.json"
echo "#   PNG:        $WORK/ramp.png"
if [[ -n "$KEEP_TMP" ]]; then
  echo "# (kept on disk because KEEP_TMP is set)"
elif [[ -n "$CLEANUP" ]]; then
  echo "# (will be cleaned up on exit — re-run with KEEP_TMP=1 to inspect)"
fi
