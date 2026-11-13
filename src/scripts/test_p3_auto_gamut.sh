#!/usr/bin/env bash
# Display-P3 Auto gate (#4741): per fixture, Auto on P3 must match its sRGB
# render where sRGB compressed nothing (mean CIEDE2000 <= 0.45) and keep at
# least Neutral's share of wide-gamut pixels (within 1e-4).
# Without a RAW fixture directory the physical gate is NOT TESTED and exits 0;
# with one, render errors, an empty selection or a missed threshold fail.
# Renders are kept under $OUTPUT_DIR/work with their SHA-256 in the JSON.
# Env: MAPLE_CLI (pinned binary), RAW_DIR, OUTPUT_DIR (evidence), FILTER.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RAW_DIR="${RAW_DIR:-$REPO_ROOT/test-fixtures/raws}"
if [[ ! -d "$RAW_DIR" ]]; then
	echo "P3 Auto gamut gate NOT TESTED: no RAW fixtures at $RAW_DIR"
	exit 0
fi
if [[ -z "${MAPLE_CLI:-}" ]]; then
	(cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli --features stage-dump >&2)
	MAPLE_CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
fi
OUTPUT_DIR="${OUTPUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUTPUT_DIR"
python3 "$SCRIPT_DIR/p3_auto_gamut_check.py" \
	--cli "$MAPLE_CLI" --raw-dir "$RAW_DIR" --work "$OUTPUT_DIR/work" \
	--filter "${FILTER:-}" --json "$OUTPUT_DIR/p3_auto_gamut.json" |
	tee "$OUTPUT_DIR/p3_auto_gamut.txt"
