#!/usr/bin/env bash
# Canonical color accuracy gate: Auto against the camera's embedded JPEG.
# Uses test_auto_profile_match.sh's unchanged per-luma-band/channel bias metric.
# Neutral keeps AgX. No Adobe reference images or Adobe budget cells are read.
# Missing RAWs/empty comparisons fail; CI reports unprovisioned RAWs separately.
# Env: MAPLE_CLI, RAW_DIR or MANIFEST (baseline RAW selection only), OUTPUT_DIR,
# FILTER and BUDGET. Evidence is retained by the embedded-JPEG runner.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/test_auto_profile_match.sh"
