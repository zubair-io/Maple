# Positive-chroma surface support (#4627)

## Scope

The positive AMaZE false-colour bound introduced in the color-gate repair
transported neighbouring channel/green ratios to the centre even across real
colour boundaries. The repair requires coherent ratios in the target plane and
in the centre's sampled CFA plane before applying that bound. It uses the
existing 15% support tolerance; numerical perceptual budgets are unchanged.
The shared demosaic runs before both CPU and GPU scene preparation.

At two failing `test_0018/clarity_min` pixels, the measured target ratios span
31.16% and 60.15% of their means. The old bound reduces the independently
computed red value correction from 0.453 to 0.111 and from 0.243 to 0.094.
These samples do not support constant-chromaticity transport. The correction
retains the existing value-domain blend there. Uniform-chromaticity luminance
edges still retain their original positive hue; measured sensor channels and
scene range are unchanged.

## Matched physical comparison

Control source: `24d9cdc207ce497da46d6cf72f2ecfa64dabdb95` (output version 29).
Candidate: that source plus the archived surface-support patch and its tests.
Version 30 subsequently invalidates derived output caches for this change.
This table qualifies the frozen prototype, not an entire version-30 release.

| Scope | Control | Candidate |
| --- | --- | --- |
| Required comparisons: all 43 test_0018 cases plus Auto baseline | 44 | 44 |
| Passing comparisons | 39 | 41 |
| Failing comparisons | 5 | 3 |
| Missing required comparisons | 0 | 0 |
| Input hashes checked before and after | 163 unchanged | 163 unchanged |
| clarity_min max ΔE2000 (ceiling 43.80) | 47.38 | 41.68 |
| temperature_max max ΔE2000 (ceiling 54.15) | 58.40 | 51.89 |

No new case fails within this fixture. Its existing `tint_max`, `tint_min`,
and `whites_min` failures remain. The already-failing tint_min maximum worsens
from 57.46 to 60.97; this result does not establish an improvement in every
metric. Original RAWs, canonical XMPs, qualified Adobe references, comparison
protocol and all budget ceilings are identical between these runs.

Control executable SHA256:
`e7d232cfe40b8265dfaab062e7d8a80fa724a55deb155697166727898aea8ec8`

Candidate executable SHA256:
`13d9ed5f41516ac1f8980b57baa4dd786f1ad7fcb413d63a4d00881ba6ef0541`

Durable evidence root: `/Volumes/Projects/maple-color-gate-20261015/`.
`fcs-positive-trace/` contains the source patch and decoded sensor witnesses;
`fcs-surface-support-control/` and `fcs-surface-support-probe/` contain frozen
harnesses, binaries, source identities, before/after input hashes, native
candidates, comparison logs and complete-case accounting.

## Automated checks

- Two independent colour-boundary tests fail on the control, then pass with
  the fix. They cover four Bayer patterns, three edge directions, three
  exposure scales, and an isolated colour surrounded by consistent target
  ratios. Their value-blend oracle does not call the support implementation.
- All 29 AMaZE tests pass, including the unchanged positive luminance-edge,
  collapsed-chroma, sampled-channel and tile-seam tests.
- Core: 2,791 passed, 0 failed, 99 fixture-gated tests ignored.
- GPU binding: 19 passed, 0 failed, 1 physical fixture test ignored.
- Synthetic gray, gray adjustments and gray DCP scripts all pass.

## Extended physical regression set

The same candidate executable completed 33 additional required comparisons:
22 pass, 11 fail, none are missing, and all 122 input hashes remain unchanged.
The evidence is in `fcs-surface-regression-probe/` under the durable root above.

All 12 native-resolution detail comparisons pass. This retains the six original
100MP detail fixes and clears the six native detail regressions observed during
the repair. Both Auto controls also pass. The 19 down-resolution comparisons
still contain 11 failures; this subset is not a full-corpus failure count.

The failing `test_0000/contrast_min` maximum was attributed separately with
matched physical controls and unchanged inputs:

| Source | Maximum ΔE2000 | Ceiling | Result |
| --- | ---: | ---: | --- |
| `1d68d656` / version 28 | 37.27 | 39.00 | Pass |
| `24d9cdc2` / version 29 | 39.26 | 39.00 | Fail |
| Surface-support candidate / version 30 runtime | 39.54 | 39.00 | Fail |

The version-29 highlight-confidence change introduced this failed case. The
surface-support correction worsens its maximum further; it does not introduce
a newly failing case here. Archives: `hr-contrast-v28-control/` and
`fcs-contrast-v29-control/`, each with five unchanged input hashes.

The ignored physical GPU white-balance test has a separately reproduced
failure in the ongoing color-gate investigation; these binding tests do not
waive it. A complete 796-cell physical color gate on committed version 30 is
running separately. Its final result, remaining regression repairs, and final
performance qualification remain required before merge. This report does not
authorize a gate exception.
