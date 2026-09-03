#!/usr/bin/env bash
# tools/codegen.sh — regenerate cross-language shape declarations from
# raw-core canonical sources. Idempotent: a second run produces zero diff.
# Wired up for #118; CI drift gate lives in `.github/workflows/cross.yml`
# (job `codegen-drift`).
#
# Schemas emitted:
#   - adjustment (raw_core::types::ADJUSTMENT_SCHEMA) → Swift + TS + TS tables
#                                            (the ts-tables target is #2683 —
#                                            see the Outputs list below)
#   - ui-tokens  (raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS,
#                                            RADIUS_TOKENS, SPACING_TOKENS})
#                                            → Swift + TS + SCSS + WinUI XAML
#                                            (ticket #606; XAML target closes
#                                            the Windows drift gap, milestone
#                                            #22 — motion is intentionally not
#                                            emitted to XAML, see codegen/src/
#                                            ui_tokens_xaml.rs::emit_xaml)
#   - color-matrices (raw_core::color::{matrices,oklab}) → WGSL + TS
#                                            (epic #925 P2 / #990; TS #1944)
#   - agx-coeffs     (src/scripts/derive_agx_lut.py) → WGSL
#                                            (epic #925 P2 / #990)
#   - film-catalog   (raw_core::film_catalog::FILM_CATALOG) → Swift + TS
#                                            (epic #2683, Task 6)
#   - capability-registry (raw_core::capability_registry::CAPABILITY_REGISTRY
#                                            judged against the evidence
#                                            records in test-fixtures/
#                                            qualification/) → Swift + TS +
#                                            C# + markdown + JSON release
#                                            summaries (#2430)
#
# Outputs:
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts
#   - src/web/projects/maple-common/src/lib/generated/adjustment-tables.generated.ts
#                                            (ADJUSTMENT_RANGES + copy/paste
#                                            group tables, split out of the
#                                            file above in #2683 to keep both
#                                            well under the file-size budget)
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift
#   - src/apple/Packages/MapleUI/Sources/MapleUI/Generated/UITokens.swift
#                                            (Maple UI Apple phase — second
#                                            emit of the same swift target
#                                            into the dependency-free MapleUI
#                                            package, which cannot import
#                                            MapleCore)
#   - src/web/projects/maple-common/src/lib/generated/ui-tokens.ts
#   - src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss
#   - src/windows/Maple.WinUI/Themes/Tokens.xaml
#                                            (colors + radius + spacing only —
#                                            the 4 hand-written <Style>
#                                            resources live alongside it, in
#                                            the NOT-generated Themes/Styles.xaml)
#   - src/raw-pipeline/raw-gpu/src/generated/color_matrices.wgsl
#   - src/web/projects/maple-common/src/lib/generated/color-matrices.generated.ts
#   - src/raw-pipeline/raw-gpu/src/generated/agx_coeffs.wgsl
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/FilmCatalog+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/film-catalog.generated.ts
#   - src/apple/Packages/MapleCore/Sources/MapleCore/Generated/CapabilityRegistry+Generated.swift
#   - src/web/projects/maple-common/src/lib/generated/capability-registry.generated.ts
#   - src/windows/Maple.WinUI/Generated/CapabilityRegistry.g.cs
#   - docs/capability-registry.md
#   - docs/capability-registry.json
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
if [ -f "${BIN}.exe" ]; then
  BIN="${BIN}.exe"
fi

# --- Adjustment schema ----------------------------------------------------

SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift"
TS_OUT="src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts"
TS_TABLES_OUT="src/web/projects/maple-common/src/lib/generated/adjustment-tables.generated.ts"

"$BIN" --schema adjustment --target swift     --out "$SWIFT_OUT"
"$BIN" --schema adjustment --target ts        --out "$TS_OUT"
"$BIN" --schema adjustment --target ts-tables --out "$TS_TABLES_OUT"

# --- UI tokens (#606) -----------------------------------------------------

UI_SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift"
UI_MAPLEUI_SWIFT_OUT="src/apple/Packages/MapleUI/Sources/MapleUI/Generated/UITokens.swift"
UI_TS_OUT="src/web/projects/maple-common/src/lib/generated/ui-tokens.ts"
UI_SCSS_OUT="src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss"
UI_XAML_OUT="src/windows/Maple.WinUI/Themes/Tokens.xaml"

"$BIN" --schema ui-tokens --target swift --out "$UI_SWIFT_OUT"
# Second Swift emit (Maple UI design-system Apple phase, #3000 lineage):
# MapleUI is a dependency-free local SPM package that cannot import
# MapleCore, so it carries its own copy of the same generated constants
# rather than depending on MapleCore's. Both files declare `MapleUITokens`
# but live in separate modules, so there's no symbol collision.
"$BIN" --schema ui-tokens --target swift --out "$UI_MAPLEUI_SWIFT_OUT"
"$BIN" --schema ui-tokens --target ts    --out "$UI_TS_OUT"
"$BIN" --schema ui-tokens --target scss  --out "$UI_SCSS_OUT"
"$BIN" --schema ui-tokens --target xaml  --out "$UI_XAML_OUT"

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

# --- Film catalog (epic #2683, Task 6) -------------------------------------
# `raw_core::film_catalog::FILM_CATALOG` — the FilmCategory enum/union, the
# FilmLookEntry shape, and the full 100-entry catalog — single-sourced to
# both Swift and TS so neither platform hand-maintains the id/name/category
# list independently of the ingested cube pack.

FILM_SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/FilmCatalog+Generated.swift"
FILM_TS_OUT="src/web/projects/maple-common/src/lib/generated/film-catalog.generated.ts"

"$BIN" --schema film-catalog --target swift --out "$FILM_SWIFT_OUT"
"$BIN" --schema film-catalog --target ts    --out "$FILM_TS_OUT"

# --- Capability registry (#2430) ------------------------------------------
# The registry table is reviewed Rust; the `core` / `integrated` /
# `released` state per capability is computed here from the harness
# evidence records in test-fixtures/qualification/ (written by
# tools/qualification/record.sh). Regenerating on every codegen run is what
# makes "evidence loss demotes a capability in the next build" true: a
# record that no longer matches the current pipeline / schema version, its
# corpus, or its declared case count stops counting, and this drift gate
# then requires the demoted outputs to be committed.

CAP_EVIDENCE_DIR="test-fixtures/qualification"
CAP_SWIFT_OUT="src/apple/Packages/MapleCore/Sources/MapleCore/Generated/CapabilityRegistry+Generated.swift"
CAP_TS_OUT="src/web/projects/maple-common/src/lib/generated/capability-registry.generated.ts"
CAP_CS_OUT="src/windows/Maple.WinUI/Generated/CapabilityRegistry.g.cs"
CAP_MD_OUT="docs/capability-registry.md"
CAP_JSON_OUT="docs/capability-registry.json"

for target_out in "swift:$CAP_SWIFT_OUT" "ts:$CAP_TS_OUT" "cs:$CAP_CS_OUT" "md:$CAP_MD_OUT" "json:$CAP_JSON_OUT"; do
  "$BIN" --schema capability-registry --target "${target_out%%:*}" \
    --evidence-dir "$CAP_EVIDENCE_DIR" --repo-root . --out "${target_out#*:}"
done

echo "codegen.sh: outputs regenerated."
echo "  - $SWIFT_OUT"
echo "  - $TS_OUT"
echo "  - $TS_TABLES_OUT"
echo "  - $UI_SWIFT_OUT"
echo "  - $UI_MAPLEUI_SWIFT_OUT"
echo "  - $UI_TS_OUT"
echo "  - $UI_SCSS_OUT"
echo "  - $UI_XAML_OUT"
echo "  - $GPU_WGSL_OUT"
echo "  - $COLOR_MATRICES_TS_OUT"
echo "  - $AGX_WGSL_OUT"
echo "  - $FILM_SWIFT_OUT"
echo "  - $FILM_TS_OUT"
echo "  - $CAP_SWIFT_OUT"
echo "  - $CAP_TS_OUT"
echo "  - $CAP_CS_OUT"
echo "  - $CAP_MD_OUT"
echo "  - $CAP_JSON_OUT"
