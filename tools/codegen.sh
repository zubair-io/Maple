#!/usr/bin/env bash
# tools/codegen.sh — regenerate cross-language shape declarations from
# `raw_core::types::ADJUSTMENT_SCHEMA`. Idempotent: a second run produces
# zero diff. Wired up for #118; CI drift gate lands in #119.
#
# Outputs:
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts
#
# The cbindgen step for the FFI header is handled by
# `src/apple/scripts/build-xcframework.sh` as part of the xcframework build —
# this script intentionally does not duplicate it.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

cargo build --release \
  --manifest-path src/raw-pipeline/Cargo.toml \
  -p codegen

BIN="src/raw-pipeline/target/release/codegen"

SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift"
TS_OUT="src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts"

"$BIN" --target swift --out "$SWIFT_OUT"
"$BIN" --target ts    --out "$TS_OUT"

echo "codegen.sh: outputs regenerated."
echo "  - $SWIFT_OUT"
echo "  - $TS_OUT"
