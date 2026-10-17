# GPU retouch and camera-stage dispatch — #4629

## Scope

The staged resident camera prefix now has a complete ordered clone/heal GPU
stage. CPU and GPU share the actual spot footprint and normalized Gaussian
kernel preparation. Each spot gathers both patches before writing, so source
overlap is deterministic and later spots consume earlier repairs. The stage
copies the full frame once and reuses patch scratch across spots. Warm frames
reuse buffers, uniforms, bind groups and unchanged kernel uploads.

This remains an explicit prerequisite under #4629. Shipping live hosts retain
their existing cached prefix. Deep denoise, persistent-host integration and
complete color/performance qualification remain required. No output/cache
version changes because the shipping render path is unchanged.

## Qualification

- **19 core retouch tests pass**, with no ignored tests. This includes **183
  GPU/CPU comparisons** using the actual CPU stage, covering borders, overlapping
  patches, ordered spots, degenerate dimensions/inputs and opacity/feather clamps.
  Maximum absolute error is **0.0000023841858**, below the unchanged **0.0001**
  ceiling. Alpha is preserved exactly.
- **310 raw-gpu library tests pass**, with five existing ignored fixture tests.
  New resource tests cover changed opacity and Gaussian kernels, mixed patch
  sizes, sequential repair, unchanged alpha, one final readback and no new GPU
  resources after warmup.
- **12 physical compositions pass** on Canon `test_0006` and Fuji `test_0005`,
  at 256-pixel long edge. Each retains the same camera upload across As Shot and
  authored WB extremes, AE on/off, ordered clone/heal, Oklab recovery, chroma
  prefilter and capture sharpening. Maximum error is **0.000032305717**.
- The **48 existing physical post-camera comparisons** also pass after the
  dispatch correction below, maximum error **0.00003552437**. Original RAWs,
  canonical manifest, budgets and all frozen source hashes are unchanged
  throughout the final qualification run.
- All **61 WGSL modules** validate. Native WASM all-feature/all-target and FFI
  GPU compilation checks pass, as do changed-file formatting and file headroom.
  CI now executes shared-geometry retouch parity on both lavapipe and Metal.

The warm identity-kernel test initially exposed Metal reassociation of
`destination + (source - low)`. Explicit per-channel zero-detail preservation
restores exact identity. The failing log and initial shader are retained.

Review also found that the new retouch and previously staged post-camera
kernels declared 256 threads while `encode_simple` dispatches 64 per group.
Both two-row dispatch regressions fail before correction and pass afterwards.
Every affected kernel now uses 64 threads and flattens both dispatch dimensions,
matching the existing shared dispatcher. This also removes the earlier fourfold
over-dispatch. The full stage and physical suites above were rerun afterwards.

Source archive, input hashes, failing controls and completed qualification logs:
`/Volumes/Projects/maple-color-gate-20261015/gpu-retouch-4629/`.
These local measurements are on Metal; they do not establish browser/lavapipe
execution, an absolute frame-time pass, or a passing full ACR color gate.
