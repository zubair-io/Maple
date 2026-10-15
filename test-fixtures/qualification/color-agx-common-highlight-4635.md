# Common-highlight AgX qualification (#4635)

This is a partial qualification record for the ongoing color-gate repair.
It does not claim a complete physical pass or authorize a merge with failed
gates. All numerical budgets, original RAWs and authored sidecars are retained.

## Operator

The existing max-channel sigmoid preserves chromaticity even when every
channel reaches the shoulder, so finite bright colors never approach white.
The candidate retains that exact arithmetic while the minimum inset channel
is at or below scene diffuse white, 1.0. Above it, a cubic Hermite weight in
log space blends the minimum from the ratio response toward its own sigmoid
value. The weight reaches one at the existing AgX upper scene bound. The
middle channel retains its original fraction between the extrema, preserving
RGB hue. No fixture, camera or scene-specific fitted constant is used.

CPU, WGSL and the GPU scalar oracle implement the same operator. The inverse
keeps the old ratio path below the boundary and solves the monotone minimum
endpoint above it. Gamut compression and clamped toe/shoulder remain lossy;
the inverse cannot recover information discarded there.

The candidate increments pipeline output version to 31, AgX version to 9,
and Auto fit version to 3. Auto remains the default profile. Generated cache
versions are updated; older qualification records are not relabeled as new
evidence.

## Physical prototype evidence

Base source: `039f59af863458c8ae070bdb7cef1d640f8f1753` (runtime v30).
Prototype binary SHA256:
`60f0cd65742ffa4e5da0990ea96d1a0d9820b58d0d9dda875249bdc93f85df6e`.
The source patch and changed-file hashes are archived with the binary.

The initial six-case run improves from four passing to five passing. The
expanded run executes all 47 required comparisons: 27 pass, 20 fail, no
missing required cells, and 170 before/after input hashes remain unchanged.
All six original 100MP native-detail controls and all six expanded Auto
baselines pass. These selected cases do not establish a full-corpus count.

Twenty-one expanded cases were paired against completed images from the
independently frozen v30 full run using its exact canonical comparator.
Failures fall from 14 to 11, with no newly failed case; all 112 input and
candidate hashes remain unchanged. Together with the initial six-case
control, the prototype clears these four failures:

| Case | v30 max ΔE | Prototype max ΔE | Unchanged ceiling |
| --- | ---: | ---: | ---: |
| test_0000/contrast_min | 39.54 | 36.61 | 39.00 |
| test_0007/tint_max | 54.39 | 45.91 | 51.10 |
| test_0007/wb_auto | 42.95 | 39.93 | 42.50 |
| test_0007/wb_tungsten | 44.19 | 37.21 | 43.80 |

The optimized candidate additionally preserves the old floating-point ratio
arithmetic and single curve sample below common diffuse white. Its binary
SHA256 is `21d5badd901be0e5c2498432e82b473e87615e7c792dc9adeae2b8de061c49e8`.
Its complete 53-comparison physical rerun has 32 passes and 21 failures,
with no missing required cells and all 194 input hashes unchanged. It
preserves all four passes in the table, with the same printed maxima. All
six Auto baselines and all six original 100MP native-detail controls pass.
The remaining Canon native sharpening case fails at max 46.99 > 46.20.
These are selected-case results, not the full-corpus remaining count.

## Candidate tests and limits

- Core: 2,799 passed, zero failed, 99 existing fixture-gated ignores.
- GPU: 284 passed, zero failed, four existing ignores; includes nine AgX
  Metal parity tests at the unchanged tolerance.
- View subset: 212 passed, eight existing ignores. New coverage includes
  independent endpoint/channel-fraction predictions, exact unchanged ratio
  arithmetic, one curve sample on that path, endpoint monotonicity and
  continuity across diffuse white.
- Hue constancy: 11 passed. Color chart: seven passed. Synthetic gray: six
  passed. Gray adjustments: 19 + 14 + six + two passed. Gray DCP: five passed.
- Banding: 89 of 90 pass. The legacy Auto1 neutral tail fails its unchanged
  0.004007 second-difference ceiling: exact main 0.00474838, v30 0.00470820,
  optimized candidate 0.00471192. The same failure exists on unchanged main;
  default Auto2 and all 80 synthetic ramp comparisons pass. No limit is
  waived. The residual LUT amplifies a pre-existing piecewise-linear curve
  knot; this record does not claim that separate failure is fixed.

Complete physical comparison, live-binding qualification, uncontended
performance, review and fresh CI remain required. The separate nonlinear
camera-WB/GPU ordering failure tracked under #4629 also remains unresolved.

## Reproducible local artifacts

Under `/Volumes/Projects/maple-color-gate-20261015/`:

- `agx-common-highlight-probe/`: initial six-case source, binary and results.
- `agx-common-highlight-expanded-probe/`: 47 comparisons and input audit.
- `agx-expanded-v30-existing-control/`: 21 exact v30 comparisons, paired
  outcomes, extracted canonical comparator and 112-file identity audit.
- `agx-production-candidate/`: optimized source snapshot, binary identity,
  test logs, complete 53-comparison run and 194-file input revalidation.
- `agx-v31-domain-gates/`, `agx-banding-control/`, `main-banding-control/`
  and `auto1-tail-trace/`: domain gates and exact-main banding attribution.
- `original-failure-coverage-audit.json`: all 92 original failures plus seven
  additional corrected tint failures remain in the 776-case manifest, with
  original failure resolutions preserved and no removed case names.
