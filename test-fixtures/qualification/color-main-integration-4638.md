# Color repair integration with main (#4638)

The repair branch was rebased onto main `5e637ce7a90b29bb07db766ecdaf07db1917f724`.
The integrated source before the final WASM import repair is
`c67542c58e4c25742897f7555f7b7c2898c854c7`.
This record does not claim a complete physical color-gate pass or authorize a merge.
No numerical budget, original RAW or authored sidecar changes in this integration.

## Conflicts and fixes

Main introduced retained CPU previews, shared chroma scaling and WASM SIMD NLM.
The integration preserves the retained `develop_sized_prefix`/detail split and
places the shared camera preparation inside that existing prefix. Chroma preparation
retains the ISO fallback when a camera has no explicit noise profile.

Both new WASM accumulation paths now retain the continuous exponential tail from
#4638. Values below eight keep vector interpolation; larger finite values use the
same canonical scalar range reduction as native. Per-lane normalization and stencil
radii remain active in the modulated path. NaN handling, ordered pruning and the
short tail retain their existing contracts.

The standalone WASM witness initially passed, but the actual browser crate build
failed: the parent module imported `fast_exp_table` only for ARM64. Its import guard
now also includes `wasm32` with `simd128`, matching the consumer's guard. The original
failed build is retained; the repaired browser build succeeds. This demonstrates why
the standalone witness cannot substitute for compiling the shipping target.

## Qualification

The broad run hashes 1155 tracked source/input files before and after execution;
the exact count and hashes are in `qualification/identity.json`. No hashed source
or RAW changed during that run. The subsequent edit changes only the target guard
above; the repaired browser build, native NLM subset and WASM witness rerun afterward.

| Gate                                                            | Result                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Core with GPU                                                   | 2,830 passed; 102 fixture-gated ignored                               |
| Explicit camera colorimetry and physical camera-prefix tests    | 5 passed; none ignored                                                |
| GPU library                                                     | 292 passed; 5 fixture-gated ignored                                   |
| Explicit HSM physical tests                                     | 4 passed; none ignored                                                |
| WASM host library with GPU                                      | 74 passed; 8 fixture-gated ignored                                    |
| FFI library with GPU                                            | 301 passed; 6 fixture-gated ignored                                   |
| Browser `wasm32`, `gpu,parallel,avif`, pinned nightly build-std | Passed after import-guard repair                                      |
| Native NLM after final repair                                   | 21 passed                                                             |
| Real WASM SIMD versus scalar witness after final repair         | 1,002,465 checks; 10 length guards passed                             |
| WGSL validation                                                 | Passed                                                                |
| Synthetic gray                                                  | 6 passed                                                              |
| Gray adjustments                                                | 19 + 14 + 6 + 2 passed                                                |
| Gray DCP                                                        | 5 passed                                                              |
| Banding, including real Auto1 and Auto2 tails                   | Passed at unchanged budgets                                           |
| Strict physical one-shot Canon GPU binding                      | 12 variants passed; max byte delta 1                                  |
| Existing native WB seam/tile regressions                        | 4 passed; none ignored                                                |
| Source file headroom                                            | Passed                                                                |
| Code generation                                                 | Regenerated capability corpus identity; status remains stale_pipeline |

Twenty-four independent sized CPU scene controls (six RAWs, Preview/AMaZE,
32/512 pixel caps) are bit-identical to the frozen pre-extraction/pre-rebase binary.
Dimensions and all output pixel bits match; all six RAW hashes remain unchanged.
This controls the extraction and main integration, not every full-resolution render.

The existing native WB seam tests retain their historical relative criteria; passing
them is not strict complete-render parity. The camera-stage physical test still isolates DCP from AE, noise reduction,
sharpening and highlight recovery. The new resident camera/DCP stage remains a
prerequisite under #4629; this report does not claim that persistent live sessions
have migrated to that boundary. Full physical gate, strict complete live parity,
uncontended performance, review and fresh CI remain required.

## Artifacts

Local evidence is under
`/Volumes/Projects/maple-color-gate-20261015/main-integration/`:

- `qualification/`: broad logs, exact source/input hashes and original browser failure.
- `browser-target-repaired.log`, `nlm-native-repaired.log`, `wasm-simd-repaired.log`:
  final import-guard qualification.
- `one-shot-lossy-physical.log`, `live-wb-seams.log`: explicit physical binding runs.
- `final-source-audit.json`: only the import guard changed after the broad source audit.
- `cpu-controls/`: 24 before/after rows and six-file input audit.
- `codegen-final.log`: generated outputs from the integrated source.

The pre-rebase source is retained on branch
`codex/color-gate-before-main-20261015-1936`.

## Current-main integration, pipeline v41

The repair branch is rebased onto main commit
`3613a6b9cf5e95a9bd1b41103752439088387d3f`. The pre-rebase v40 checkpoint is
`c85b618a3c` on `codex/color-gate-v40-before-main-3613a6b`.
Main's extended-range ICC raster decode and GPU-prefix ownership changes are
retained. Its new Android binding is included in generated output version 41.
The conflicting module declaration keeps both the shared camera prefix and
main's crate-visible capture-sharpening helper.

Main independently shipped its ICC behavior as output version 25; this repair
branch used diagnostic versions 25–40. Version 41 gives the combined runtime a
new derived-artifact identity. It does not relabel prior physical evidence as
validation of the rebased code. Fresh domain and physical qualification remain
required; the separate A=-.5 resampling experiment is still unadopted.
