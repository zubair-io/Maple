# Lens resampling isolation — #4650

## Saved candidate

This candidate follows the balanced-AMaZE and Bayer GainMap changes from
#4627/#4647. Their fresh Pixel `exposure_max` comparison measures maximum
DeltaE 45.303858 on main, 54.377235 with balanced AMaZE, and 50.456601 after
GainMaps; all exceed the unchanged maximum ceiling 34. The combined change
improves average error but worsens the maximum relative to main, so it is
not accepted for merging.

The isolated candidate uses Catmull–Rom coefficients (A=-0.5) in the existing
32-phase cubic lens sampler. Adobe's SDK uses A=-0.75; this is a deliberate
reconstruction choice for Maple's unbounded scene data, not a claim of SDK
kernel identity. It reproduces affine/quadratic data and reduces the analytic
negative lobe while retaining signed/HDR samples, tap coordinates, table
phase selection, sticky borders and full/window agreement. The table remains
compile-time data and introduces no sampling allocation.

Only the shared ordinary RAW opcode sampler, its tests and its documentation
change. The earlier large repair's generated versions and other pipeline
changes are not imported. A preceding broad-branch result is diagnostic
history, not qualification for this isolated candidate.

## Initial qualification

All **30 opcode tests pass**, including the new all-phase affine/quadratic,
translated-window and analytic ringing checks, plus existing constant,
integer, signed/HDR, border, warp and gain-map tests. This does not yet
establish a physical improvement on the current integration base.

## Qualification required

Run the analytic opcode tests, fresh Pixel and all affected camera cases,
complete corpus, CPU/GPU and binding parity, and performance checks against
the frozen current-main and combined controls. Cache versions and generated
evidence must be integrated on the actual merge revision. Numerical budgets,
original RAWs, authored sidecars and Adobe references remain unchanged.

Replay patch and fresh logs are preserved in
`/Volumes/Projects/maple-color-gate-20261015/lens-resampling-isolated/`.
