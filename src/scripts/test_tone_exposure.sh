#!/usr/bin/env bash
# Real ACR +/-1 EV response gate (#3631); retains Exposure's exact 2^EV scale.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 "$ROOT/tools/tone_exposure_gate.py" --self-test
EXPOSURE_WORK="$(mktemp -d "${TMPDIR:-/tmp}/maple-tone-exposure.XXXXXX")"
trap 'rm -rf "$EXPOSURE_WORK"' EXIT
if python3 "$ROOT/tools/tone_exposure_gate.py" --prepare "$EXPOSURE_WORK/manifest.json"; then
  :
else
  status=$?
  if [[ "$status" == 3 ]]; then exit 0; fi
  exit "$status"
fi
# Always ask Cargo to validate freshness. No stale prebuilt-producer shortcut.
cd "$ROOT/src/raw-pipeline"
cargo build --release -p raw-core --example tone_sprint
for fixture in test_0002 test_0017; do
  cargo run --release -p raw-core --example tone_sprint -- \
    "$EXPOSURE_WORK/manifest.json" "$EXPOSURE_WORK/candidates" "$fixture" 1024
done
python3 "$ROOT/tools/tone_exposure_gate.py" --candidates "$EXPOSURE_WORK/candidates"
