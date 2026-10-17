# Strong-sharpening bright halos — #4837

This is an isolated, unpromoted correction on the #4112 neighborhood branch
(`c95d1a7de96bbfec52d5bf55a68da241fde1e2df`). It also inherits the pending
AMaZE, sensor GainMap and lens-sampling corrections. It does not include the
separate local-highlight-recovery correction, change output/cache versions,
or qualify the combined stack for landing.

## Attributed defect

A source-guarded Nikon `test_0014/sharpen_amount_max` trace found scene-linear
luminance increasing from 0.424451 to 0.703052 at amount 150. Its observed 3×3
neighborhood contains no brighter supporting sample. Camera-balanced AMaZE
already raises interpolated green at this pixel; the AMaZE-only native max
DeltaE 51.526 exceeds the unchanged 50.9 ceiling (main: 48.397).

The trace separates these stages. The current correction addresses the
additional strong-sharpening halo; it does not claim that AMaZE interpolation
itself is corrected.

## Correction

The existing default amount remains the exact arithmetic boundary. Above that
amount, brightening approaches the brighter of the observed 3×3 luminance and
the default result. In gain units, with default gain `a`, available room `r`,
and requested additional gain `e`, the extension is `e / (1 + e/r)` when
`r > 0`, otherwise zero. A supported brighter neighbor still allows a
monotonic response to stronger amounts; an isolated peak retains its default
gain. This form avoids subtracting large nearly equal values.

Rust and WGSL use the same operations and existing luminance plane. No new
allocation, GPU dispatch, binding, camera rule, or configuration setting is
introduced. Scene-linear HDR and signed RGB ratios are preserved. The
generated shared constant is renamed to describe its use for both signs.

## Completed checks

- Three independent synthetic bright-step, isolated-peak and scalar-oracle
  controls fail against the unchanged implementation.
- All 24 sharpening CPU tests pass after the correction, including the
  default arithmetic, darkening, signed/HDR, radius and fused-pass controls.
- All 9 sharpening GPU tests pass on Metal, including the new bright-halo
  test across radii, HDR exposures, borders and masking settings. The unchanged
  CPU/GPU error ceiling is `1e-4`; alpha is preserved.
- Code generation completed; whitespace and file headroom checks pass.

## Still required

Native ACR comparisons, the whole core/GPU/binding suites, any independently
justified Maple-only synthetic-golden update, current-main/cache integration,
performance acceptance and PR review remain outstanding. Original RAWs, XMPs,
Adobe reference pixels and numerical budgets must remain unchanged.

Evidence is retained under
`/Volumes/Projects/maple-color-gate-20261015/sharpen-bright-halos-isolated/`.
The original Nikon stage traces and source/binary identities are under
`sharpen-neighborhood-isolated/0014-amaze-attribution/` in that same root.
