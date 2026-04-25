# Plan 3 M2.1 fixtures

## synthetic-input.bin

- Size: 2048 bytes (16 × 16 × 4 × 2).
- Format: fp16 RGBA, row-major, top-left origin.
- Content: scene-linear Rec.2020 swept diagonally over the [0.06, 4.0] linear
  range (~6 EV) with mild chroma variation per row.
- Reproducible: `bun run scripts/generate-synthetic-input.ts` from this dir
  (or run from repo root; the script uses `import.meta.dir`).

## reference.png

- Size: 16 × 16 sRGB RGBA8 PNG.
- Source: Apple Metal dev-chain rendered against `synthetic-input.bin`.
- AdjustmentModel:
  - exposure: 1.0
  - contrast: 25
  - highlights: -30
  - shadows: 40
  - whites: 0
  - blacks: 0
  - temperature: 5500
  - tint: -10
  - vibrance: 50
  - saturation: -20
- Generator:
  `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WebglParityFixtureGenerator.swift`
  (`testGenerateWebglParityReference`).
- Re-run when:
  - The Apple Metal kernel implementations change (Plan 2 v2 onward).
  - AGX_VERSION bumps in `src/raw-pipeline/raw-core/src/view/agx_coeffs.rs`.
  - Any of the GLSL shaders' constants are updated (the codegen scaffold M2.3 adds will catch this).
  - `synthetic-input.bin` is regenerated.
- Last regeneration: 2026-04-25 (Plan 3 M2.1 first run).
