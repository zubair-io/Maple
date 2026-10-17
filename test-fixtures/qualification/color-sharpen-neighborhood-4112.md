# Local dark-envelope sharpening candidate — #4112

## Scope

This unreleased candidate sits on the isolated AMaZE, Bayer GainMap and lens
resampling stack at `7f0543ca80f82499eb07f13a7234b146bdf27c64`.
It is not yet qualified for a PR or merge. Cache/output epoch integration,
full physical comparisons, broader platform gates and performance remain open.

The production trace on the unchanged Pixel sharpening sidecar found that USM
reduced scene luminance at (1108,1591) from 0.279494 to 0.059894 beside a bright
edge. The positive-gain guard prevented inversion but still created a dark halo.
A neutral step-edge regression reproduced excessive darkening before the edit.

## Correction

Keep the original blend through the default effective amount, and preserve
brightening, masking and signed/HDR behavior. Beyond the default, the darkening
gain approaches the darker of the original 3×3 luminance minimum and default
output. The reciprocal continuation retains the blend slope where there is
room to darken, and remains at the default when it already crosses the local
minimum. The exact default blend arithmetic avoids a one-ULP brightening at
that plateau. CPU and WGSL share this operation order and boundary policy.

Only above-default darkening reads the neighborhood. The existing luma plane
is reused; no new plane, allocation, dispatch, user parameter or camera rule
is introduced. Reference bytes, original RAW/XMP and numerical budgets remain
unchanged.

## Evidence so far

- Before edit: the new physical-behavior step-edge test fails.
- 20 CPU sharpening tests and 8 Metal sharpening tests passed on the first
  physical candidate. One additional independent closed-form continuation
  test is included for the upcoming complete suite.
- Pixel full-resolution `sharpen_amount_max`, all 12,419,584 pixels:

| Metric | Lens-stack control | Candidate | Ceiling |
| --- | ---: | ---: | ---: |
| Maximum ΔE2000 | 66.770884 | 45.204288 | 64.7 |
| Mean ΔE2000 | 9.938820 | 9.700059 | 13.0 |
| p95 ΔE2000 | 14.348737 | 14.010412 | 23.5 |
| Maximum absolute channel bias | 0.113198 | 0.107834 | 0.1593 |

All four metrics pass. The control is a new regression introduced by the
stack; current main already passes this case at maximum ΔE2000 60.420009.
This result repairs that regression, not an additional original-main failure.
Original inputs and the frozen executable hashes are unchanged after comparison.

All 18 full-resolution high-amount cases are being compared using the frozen
corrected native-pair protocol. No full-corpus pass is claimed. The underlying
AMaZE candidate also has separately confirmed new `test_0007` Neutral/Auto
baseline failures, so the combined stack remains unready to merge.

Evidence, exact source patch, executable identity and replay script are in
`/Volumes/Projects/maple-color-gate-20261015/sharpen-neighborhood-isolated/`.
