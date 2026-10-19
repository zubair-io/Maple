#!/usr/bin/env bash
# Auto accuracy gate: camera embedded JPEG, never Adobe Camera Raw.
# Uses the unchanged five-luma-band/channel bias budget (default 0.05).
# Missing fixtures, render errors and zero measurable comparisons FAIL.
# A genuine missing-preview sentinel is reported separately, never as a pass.
# Evidence (images, logs, hashes, per-band metrics) is retained.
# Env: MAPLE_CLI (pinned binary), RAW_DIR or MANIFEST (baseline RAW selection),
# OUTPUT_DIR (new evidence directory), FILTER (substring), BUDGET (default .05).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -z "${MAPLE_CLI:-}" ]]; then
	(cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >&2)
	MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
fi
args=(--cli "$MAPLE_CLI" --budget "${BUDGET:-0.05}" --filter "${FILTER:-}")
if [[ -n "${MANIFEST:-}" ]]; then
	args+=(--manifest "$MANIFEST")
else
	args+=(--raw-dir "${RAW_DIR:-$REPO_ROOT/test-fixtures/raws}")
fi
[[ -z "${OUTPUT_DIR:-}" ]] || args+=(--output "$OUTPUT_DIR")
exec python3 "$SCRIPT_DIR/auto_profile_match.py" "${args[@]}"
