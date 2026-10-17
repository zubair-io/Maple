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

## Nikon physical result and remaining regression

All 45,441,024 native pixels were compared with the unchanged reference and
budgets. The candidate binary and every original input retain their hashes.
The maximum breach clears, but the candidate is **not accepted for landing**:

| Metric | Main | AMaZE only | Previous dark-halo stack | Bright-halo candidate | Ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| max DeltaE | 48.397338 | 51.526272 | 51.662794 | 45.297992 | 50.9 |
| green bias | 0.16156594 | 0.16216959 | 0.16924550 | 0.16627332 | 0.1616 |

The earlier case-level classification grouped all three channels under `bias`.
That concealed a new green-channel breach because red and blue already fail
on main. The table corrects that classification: AMaZE introduces a green
breach, the dark-halo change increases it, and this bright-halo change reduces
it without clearing it. Existing-main exceptions do not qualify that new
dimension. Red/blue biases remain failing; mean 15.071840 and p95 27.258441 pass
their unchanged ceilings 15.6 and 28.1.

These are measurements of frozen runtime commit
`346f9c003e28a191386b94025eaa53bb4da13679`. Its release binary hash is
`2e480ece6812987911a3fcd1eb78792568fd7c245beb335359918a34700b87f1`.
The 18-case maximum-amount comparison and complete platform suites are running.

## Still required

Native ACR comparisons, the whole core/GPU/binding suites, any independently
justified Maple-only synthetic-golden update, current-main/cache integration,
performance acceptance and PR review remain outstanding. Original RAWs, XMPs,
Adobe reference pixels and numerical budgets must remain unchanged.

Evidence is retained under
`/Volumes/Projects/maple-color-gate-20261015/sharpen-bright-halos-isolated/`.
The original Nikon stage traces and source/binary identities are under
`sharpen-neighborhood-isolated/0014-amaze-attribution/` in that same root.
