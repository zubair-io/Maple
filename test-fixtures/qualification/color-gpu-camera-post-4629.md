# GPU post-DCP recovery and chroma prefilter — #4629

## Scope

The resident camera prefix must run white balance before DCP colorimetry and
then retain the CPU order through auto exposure. Two previously CPU-only
operations in that interval now have complete GPU kernels:

- Oklab highlight recovery, including the sensor-clip predicate, signed cube
  roots, fixed lightness, bounded chroma search and fully bright fallback.
- The chroma prefilter, including the sparse eight-neighbor stencil, border
  renormalization, luma-guided weights, chroma-magnitude limit, exact uniform
  identity, strength clamp and unchanged alpha.

Both use the existing resource pool and cached compute pipelines. Constants,
tap positions and spatial weights are generated from the CPU implementations;
the CPU arithmetic is unchanged. The kernels consume scene-linear Rec.2020
after DCP and precede capture sharpening and auto exposure.

This is an explicitly staged prerequisite under #4629. Shipping live hosts
still use their existing cached prefix. Retouch, deep denoise, persistent-host
integration, complete physical color qualification and absolute frame-time
qualification remain required before the camera-boundary migration can land.
No output or cache version changes because no shipping render path is changed.

## Qualification

- Complete raw-gpu library: **304 passed, zero failed**, five existing ignored
  fixture tests. The three new stage tests all execute.
- Direct GPU/CPU stage comparisons cover single pixels, single rows/columns,
  irregular dimensions, borders, negative channels, HDR, alpha, strength
  threshold/clamp and both stage compositions. Worst absolute error is
  **0.0000023841858**, below the unchanged **0.0001** ceiling.
- Uniform fields and unclipped recovery are exact identities. Repeated stage
  sequences with changing strengths allocate no new GPU resources after warmup.
- **48 real-RAW comparisons** execute over Canon `test_0006`, Fuji `test_0005`,
  `test_0017` and `test_0018`, at a 256-pixel long edge. Each reuses the actual
  uploaded camera image across As Shot and authored WB extremes, with both
  recovery modes and AE on/off. Chroma filtering and capture sharpening are
  enabled, in canonical order. Worst error is **0.00003552437 < 0.0001**.
  Each composition uses one final readback and preserves alpha.
- Eleven color-matrix generation tests pass. Repeated generation introduces
  no drift. All **58 WGSL modules** validate. Changed Rust formatting and
  repository file headroom pass.
- Final source patch and all four original RAW hashes, canonical manifest
  and budgets remain unchanged throughout qualification.

The first uniform-color GPU test exposed backend reassociation of the chroma
subtraction: a uniform blue value of `-0.01` moved by several billionths.
An explicit equal-neighborhood passthrough preserves the CPU's exact identity
contract. The original failure and initial shader are retained. A whole-workspace
format check also reports existing formatting differences in untouched files;
the changed-file check passes after ordering the new public exports.

Source patches, identities, failing control, complete logs and the repeated
final qualification are archived under
`/Volumes/Projects/maple-color-gate-20261015/gpu-camera-post-4629/`.
These results do not claim a passing full ACR color gate or a qualified live UI.
