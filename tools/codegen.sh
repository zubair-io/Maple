#!/usr/bin/env bash
# tools/codegen.sh — regenerate cross-language shape declarations from
# raw-core canonical sources. Idempotent: a second run produces zero diff.
# Wired up for #118; CI drift gate lives in `.github/workflows/cross.yml`
# (job `codegen-drift`).
#
# Schemas emitted:
#   - adjustment (raw_core::types::ADJUSTMENT_SCHEMA) → Swift + TS
#   - ui-tokens  (raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS})
#                                            → Swift + TS + SCSS (ticket #606)
#
# Outputs:
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift
#   - src/web/projects/maple-common/src/lib/generated/ui-tokens.ts
#   - src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss
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

# --- Adjustment schema ----------------------------------------------------

SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift"
TS_OUT="src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts"

"$BIN" --schema adjustment --target swift --out "$SWIFT_OUT"
"$BIN" --schema adjustment --target ts    --out "$TS_OUT"

# --- UI tokens (#606) -----------------------------------------------------

UI_SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift"
UI_TS_OUT="src/web/projects/maple-common/src/lib/generated/ui-tokens.ts"
UI_SCSS_OUT="src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss"

"$BIN" --schema ui-tokens --target swift --out "$UI_SWIFT_OUT"
"$BIN" --schema ui-tokens --target ts    --out "$UI_TS_OUT"
"$BIN" --schema ui-tokens --target scss  --out "$UI_SCSS_OUT"

echo "codegen.sh: outputs regenerated."
echo "  - $SWIFT_OUT"
echo "  - $TS_OUT"
echo "  - $UI_SWIFT_OUT"
echo "  - $UI_TS_OUT"
echo "  - $UI_SCSS_OUT"
