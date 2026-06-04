#!/usr/bin/env bash
# Offline exploration: how does k affect Auto vs ACR chroma?
# Not shipped in production; used to pick a conservative CHROMA_STRENGTH default.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$REPO/src/raw-pipeline/target/release/maple-cli"
if [ ! -f "$BIN" ]; then
  echo "Build maple-cli first: cd src/raw-pipeline && cargo build --release --bin maple-cli"
  exit 1
fi
for k in 0.3 0.4 0.5 0.6 0.7 0.8; do
  python3 "$REPO/src/scripts/_chroma_acr_explore.py" "$BIN" "$k"
done
