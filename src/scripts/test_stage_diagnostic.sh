#!/usr/bin/env bash
# test_stage_diagnostic.sh — per-stage diagnostic harness for the Rust pipeline.
#
# Builds maple-cli with `--features stage-dump`, renders a fixture with
# `MAPLE_STAGE_DUMP=<tmp>` set, and runs `stage_stats.py` to surface per-stage
# per-channel statistics (min/max/mean, out-of-gamut counts, achromatic
# drift in shadows/highlights).
#
# Companion to:
#   * `test_color_pipeline.sh`   — end-to-end ΔE gate vs ACR references.
#   * `stage_diff.py`            — cross-trace ΔE between two stage dirs.
#
# This script is a DIAGNOSTIC, not a gate — exits 0 unless the build itself
# fails. Use the JSON output for downstream gates as they get built out.
#
# Tracks #260 (per-stage EXR dumps + diagnostics).
#
# Env overrides:
#   FIXTURE       Path to the RAW to render. Default: the committed synthetic
#                 grey DNG (src/apple/MapleUITests/Fixtures/synthetic/
#                 grey-l018-rggb.dng) — always present, no skip-pass needed.
#   OUT_DIR       Where to keep dump EXRs + JSON. Default: a tmp dir under
#                 /tmp; set this to inspect the EXRs after the run.
#   KEEP_TMP      Non-empty -> leave the tmp dir behind for inspection.
#   PARAMS        Optional XMP path passed to maple-cli --params.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FIXTURE="${FIXTURE:-$REPO_ROOT/src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng}"
PARAMS="${PARAMS:-}"
KEEP_TMP="${KEEP_TMP:-}"

if [[ ! -f "$FIXTURE" ]]; then
  echo "test_stage_diagnostic: FIXTURE not found: $FIXTURE" >&2
  echo "test_stage_diagnostic: SKIP — no fixture available" >&2
  exit 0
fi

# Working dir for the dump + outputs.
if [[ -n "${OUT_DIR:-}" ]]; then
  mkdir -p "$OUT_DIR"
  WORK="$OUT_DIR"
  CLEANUP=""
else
  WORK="$(mktemp -d -t maple-stage-diagnostic-XXXXXXXX)"
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

# Build maple-cli with the stage-dump feature. Re-uses any cached artifacts.
echo "# Building maple-cli with --features stage-dump..."
(
  cd "$REPO_ROOT/src/raw-pipeline"
  cargo build -p maple-cli --features stage-dump --release >/dev/null
)
MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"

# Render.
echo "# Rendering $FIXTURE → $WORK/out.png with stage-dump → $DUMP_DIR"
RENDER_ARGS=(render "$FIXTURE" --out "$WORK/out.png")
if [[ -n "$PARAMS" ]]; then
  RENDER_ARGS+=(--params "$PARAMS")
fi
MAPLE_STAGE_DUMP="$DUMP_DIR" "$MAPLE_CLI" "${RENDER_ARGS[@]}"

# Count dumps.
N_EXR=$(find "$DUMP_DIR" -name '*.exr' | wc -l | tr -d ' ')
if [[ "$N_EXR" -eq 0 ]]; then
  echo "test_stage_diagnostic: ERROR — no EXR files written to $DUMP_DIR" >&2
  echo "(likely the binary was built without the stage-dump feature)" >&2
  exit 1
fi
echo "# Wrote $N_EXR stage EXRs."
echo ""

# Stats.
python3 "$SCRIPT_DIR/stage_stats.py" "$DUMP_DIR" --json "$WORK/stage_stats.json"

echo ""
echo "# Diagnostic outputs:"
echo "#   stage EXRs: $DUMP_DIR"
echo "#   JSON:       $WORK/stage_stats.json"
if [[ -n "$KEEP_TMP" ]]; then
  echo "# (kept on disk because KEEP_TMP is set)"
elif [[ -n "$CLEANUP" ]]; then
  echo "# (will be cleaned up on exit — re-run with KEEP_TMP=1 to inspect)"
fi
