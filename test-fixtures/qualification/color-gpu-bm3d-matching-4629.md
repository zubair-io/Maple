# GPU BM3D joint matching — #4629

## Scope

The staged resident camera prefix now has GPU joint block matching for BM3D.
One workgroup computes each reference patch's mean-relative distances, retains
the reference first, sorts by distance and scan position, and truncates to the
same power-of-two group size as the CPU. The reference grid includes the final
edge patch. Luma and the threshold are resident buffers; match storage is bounded
to one reference-grid row. Geometry constants are generated from raw-core.

This is an explicit prerequisite under #4629. Collaborative filtering,
ordered aggregation, the complete deep-denoise stage, persistent-host integration
and absolute performance qualification remain required. Shipping hosts and CPU
arithmetic are unchanged; this checkpoint does not change cache/output versions
or clear any ACR color-gate failures.

## Qualification

- **1,865 exact ordered group comparisons pass** against raw-core's actual
  `matching::find_group`. The 1,370 synthetic groups cover borders, uniform
  fields, gradients, checkerboards, signed HDR noise, exact distance thresholds
  and adjacent f32 thresholds. Group counts, selected positions and order all
  agree; there is no tolerance on those assertions.
- **495 physical groups pass** from Canon `test_0006.DNG` and Fuji
  `test_0005.RAF`, developed at 64-pixel long edge with chroma prefilter enabled.
  Both camera images are checked at strengths 1, 25 and 100 using the CPU's
  median-based threshold. The original RAW hashes remain unchanged.
- **22 core BM3D tests pass**, with no ignored tests in the local qualification.
- **311 raw-gpu tests pass**, with five existing fixture tests ignored. The new
  resource test changes luma, threshold and reference row, then restores the
  original inputs. Results update correctly and no GPU buffer or bind-group
  allocations occur after warmup.
- **63 WGSL modules validate**. The generator contract test and regeneration,
  native WASM all-feature/all-target and FFI GPU compile checks, changed-file
  formatting and file headroom pass. CI includes the fixture-free CPU/GPU
  matching tests on both lavapipe and Metal.

## Rounding regression

The first kernel fused the square and accumulation in the distance calculation.
On Metal this changed exact-distance ties and reordered selected patches on a
17-by-23 synthetic image. Instrumented GPU distances matched a CPU `mul_add`
control bit for bit, while both patch means already matched the CPU reference.

The corrected kernel materializes squared residuals in the existing private
patch array, then sums them in CPU order. The original failing case and all
threshold/order assertions pass. The CPU arithmetic and shader compiler flags
are unchanged. Initial failing logs, the diagnostic shader and final source
hashes are retained in
`/Volumes/Projects/maple-color-gate-20261015/gpu-bm3d-matching-4629/`.

These measurements establish local Metal matching parity. They do not establish
complete BM3D pixel parity, browser/lavapipe execution or an absolute frame-time
pass.

The subsequent filtering/aggregation checkpoint is documented in
`color-gpu-bm3d-filtering-4629.md`, including requalification of matching after
the row layout gained resident noise parameters.
