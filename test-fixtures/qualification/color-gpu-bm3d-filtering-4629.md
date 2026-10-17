# GPU BM3D collaborative filtering and aggregation — #4629

## Scope

Both BM3D opponent-channel passes now run entirely on the GPU: hard thresholding
produces the basic estimate, then that resident result supplies the Wiener pass's
matching and filter guide. DCT basis coefficients and filter constants come from
raw-core through codegen. Patch means use the CPU's pairwise reduction; group
transforms and weight reductions follow its ordering.

Each row stores weighted estimate-minus-original deltas before aggregation.
This keeps the multiply separate from the ordered additions. Every output pixel
visits contributing reference columns and group members in CPU scan order, and
reference rows run sequentially. No floating-point atomics are used. Matching
and filtered-patch storage are allocated once per pass and reused across all
rows; accumulators are cleared each invocation. Every kernel uses at most four
storage bindings and the filtering workgroup uses less than 16 KiB.

The matching record now carries the three noise sigmas beside its positions,
so filtering consumes GPU-derived parameters without a CPU readback or fifth
storage binding. The parameter buffer layout is
`[tau_squared, sigma_y, sigma_c1, sigma_c2]`.

This is a staged prerequisite under #4629. GPU median/noise anchoring, RGB to
opponent conversion, high-frequency reconstruction, the complete RGB-stage gate,
persistent-host integration and absolute frame time remain to be qualified.
Shipping hosts and CPU arithmetic are unchanged; no cache/output version or
color budget changes are made.

## Qualification

- **443,520 filtered patch-channel estimates** agree with the actual CPU
  `group_spectra`, `shrink_group` and inverse DCT routines. Maximum absolute
  reconstructed estimate error is **0.0000007599592**, below **0.0001**.
  Weights also pass their relative-error assertion. This covers both filter
  kinds, full and partial groups, uniform/gradient/noisy content and borders.
- **60 complete pass outputs / 178,416 channel values** pass against CPU
  `run_pass`, with maximum absolute error **0.00000071525574**. The Wiener pass
  consumes the GPU basic estimate directly, with no intermediate upload or
  readback. Uniform inputs are bit-exact and the fourth lane is preserved.
- Those totals include **12 physical-camera pass outputs** from Canon
  `test_0006.DNG` and Fuji `test_0005.RAF`, at strengths 1, 25 and 100 and
  64-pixel long edge. Their **104,832 channel values** have maximum error
  **0.000000059604645**. Original RAW hashes remain unchanged.
- **25 core BM3D tests pass**, including all fixture-gated tests in the local
  run. The previous **1,865 exact ordered matching comparisons** also pass
  with the shared row layout.
- **312 raw-gpu tests pass**, with five existing fixture tests ignored. The new
  warm-frame test changes noise parameters and source pixels, restores them,
  and checks repeatability, accumulator clearing and exact fourth-lane
  preservation. No additional GPU buffers or bind groups are allocated after
  warmup.
- **67 WGSL modules validate**, both BM3D codegen tests pass, and regeneration,
  native WASM all-feature/all-target and FFI GPU compilation, formatting and
  file headroom pass. CI runs the BM3D unit/parity suite on lavapipe and Metal.

The first integrated run caught a reserved WGSL identifier in aggregation;
that failure and the corrected passing runs are retained. Qualification source
and RAW hashes are checked again after all steps. Evidence is under
`/Volumes/Projects/maple-color-gate-20261015/gpu-bm3d-filtering-4629/`.

These are local Metal measurements. They do not establish browser/lavapipe
execution, complete RGB-stage parity, absolute frame-time compliance or a
passing ACR corpus gate. This checkpoint clears no ACR failures.
