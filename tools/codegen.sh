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
#   - color-matrices (raw_core::color::{matrices,oklab}) → WGSL + TS
#                                            (epic #925 P2 / #990; TS #1944)
#   - agx-coeffs     (src/scripts/derive_agx_lut.py) → WGSL
#                                            (epic #925 P2 / #990)
#
# Outputs:
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift
#   - src/web/projects/maple-common/src/lib/generated/ui-tokens.ts
#   - src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss
#   - src/raw-pipeline/raw-gpu/src/generated/color_matrices.wgsl
#   - src/web/projects/maple-common/src/lib/generated/color-matrices.generated.ts
#   - src/raw-pipeline/raw-gpu/src/generated/agx_coeffs.wgsl
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

# --- Color matrices → WGSL (epic #925 P2 / #990) --------------------------
# The GPU scene-linear kernels (raw-gpu) bake the Oklab + Rec.2020/sRGB
# matrices as WGSL consts. Single-sourced from the same raw-core constants
# the CPU pipeline uses; this output rides the codegen-drift gate so a
# matrix retune can't silently diverge from the GPU copy.

GPU_WGSL_OUT="src/raw-pipeline/raw-gpu/src/generated/color_matrices.wgsl"
COLOR_MATRICES_TS_OUT="src/web/projects/maple-common/src/lib/generated/color-matrices.generated.ts"

"$BIN" --schema color-matrices --target wgsl --out "$GPU_WGSL_OUT"

# TS counterpart (#1944): the ONE matrix a TS caller consumes today
# (`image-utils.ts`'s non-RAW/JPEG-PNG ingestion path) — single-sourced here
# instead of hand-typed, so it can't silently drift from the GPU copy above.
"$BIN" --schema color-matrices --target ts --out "$COLOR_MATRICES_TS_OUT"

# --- AgX coefficients → WGSL (epic #925 P2 / #990) ------------------------
# The headless GPU AgX kernel (raw-gpu/src/agx.wgsl) bakes the inset/outset
# matrices + log-encode scalars as WGSL consts, single-sourced from the SAME
# coefficients `derive_agx_lut.py` emits to agx_coeffs.rs + the GLSL shader.
# Only the WGSL is regenerated here so the codegen-drift gate covers it.
#
# NOTE: agx_coeffs.rs / agx_lut.bin / the Apple-bundled LUT are deliberately
# NOT regenerated here. They live with the existing AgX-derivation workflow
# (the `--bin --rs --apple-bin` invocation in the script's usage docstring).
# The WGSL emitter uses only the matrices + scalars, which are independent of
# AGX_VERSION, so it is fully idempotent.
AGX_WGSL_OUT="src/raw-pipeline/raw-gpu/src/generated/agx_coeffs.wgsl"

python3 src/scripts/derive_agx_lut.py --wgsl "$AGX_WGSL_OUT"

echo "codegen.sh: outputs regenerated."
echo "  - $SWIFT_OUT"
echo "  - $TS_OUT"
echo "  - $UI_SWIFT_OUT"
echo "  - $UI_TS_OUT"
echo "  - $UI_SCSS_OUT"
echo "  - $GPU_WGSL_OUT"
echo "  - $COLOR_MATRICES_TS_OUT"
echo "  - $AGX_WGSL_OUT"
