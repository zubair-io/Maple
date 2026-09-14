#!/usr/bin/env bash
# Auto and Neutral Whites response regression; independent of Neutral color budgets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 -m unittest discover -s "$ROOT/tools" -p test_tone_whites_gate.py
WHITES_WORK="$(mktemp -d "${TMPDIR:-/tmp}/maple-whites.XXXXXX")"
trap 'rm -rf "$WHITES_WORK"' EXIT
if python3 "$ROOT/tools/tone_whites_gate.py" --prepare "$WHITES_WORK/manifest.json"; then
  :
else
  status=$?
  if [[ "$status" == 3 ]]; then exit 0; fi
  exit "$status"
fi
cd "$ROOT/src/raw-pipeline"
cargo build --release -p maple-cli
for profile in auto neutral; do
  cargo run --release -p maple-cli -- batch --manifest "$WHITES_WORK/manifest.json" \
    --out-dir "$WHITES_WORK/$profile" --profile "$profile" --no-bundled-lens
  python3 "$ROOT/tools/tone_whites_gate.py" --candidates "$WHITES_WORK/$profile" --profile "$profile"
done
