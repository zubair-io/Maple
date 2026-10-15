# ISO fallback and continuous NLM weights — #4638

This is the qualification record for the noise-reduction repair on the broader
color-gate branch. It is not a complete physical color-gate pass or a merge waiver.
Original RAWs, adjustment sidecars, Adobe references and numerical color budgets
remain unchanged. Auto remains the default profile.

## Defects and correction

The absent-profile path never engaged the existing ISO fallback: its dynamic flag
only tested whether a DNG NoiseProfile was supplied, and large five-tap planes
entered the fixed-strength tiled kernel first. The repair routes a known ISO
through the existing coefficients, without changing or claiming physical
calibration for that heuristic. Unknown ISO with no profile remains fixed-strength;
supplied-profile routing retains its previous behavior.

The CPU implementation retains cache-local tiles. Per-worker scratch stores each
tile's strengths and radii, SIMD accumulation consumes them directly, and exactly
uniform, full-radius tiles reuse the constant-strength loop. Constant and dynamic
accumulators are specialized before entering the vector loop. Pixel reduction order,
border support and cancellation are retained.

Expanded GPU qualification exposed a second defect. The exponential approximation
discarded every weight at distance 8 or above. Although exp(-8) is small in absolute
terms, NLM normalizes its weights and uses their maximum for the center sample.
At pixel (108, 120) of the 300×200 aggressive present fixture, a distance within a
few millionths of 8 amplified ordinary floating-point differences into a 0.003325
scene-channel discrepancy and a two-code output difference, exceeding the existing
one-code present gate.

CPU, NEON and WGSL now extend the existing 513-entry interpolation table using
canonical exp(-8n) factors. Range reduction retains the positive tail until binary32
underflow; it does not add a scene-range clamp. Both formerly failing present tests
pass their original tolerance. A shared test-metadata correction also gives the
composed CPU and GPU oracles the same ISO 100; previously the GPU had ISO 0 while
the CPU used 100, which the unused fallback had concealed.

Pipeline output version 32 invalidates derivatives affected by these pixel changes.
Auto-fit model version 4 also invalidates fitted artifacts from the old NR input.

## Independent evidence

- The absent-profile regression fails on the preceding implementation and compares
  against an independently encoded existing ISO fallback at two image sizes.
- The exponential-tail regression fails on the preceding implementation because
  exp(-8) disappears. The candidate gates continuity and relative error through 88.
- SIMD accumulation is bit-identical to the scalar weight calculation, including
  per-pixel modulation, stencil masks and the vector tail. An exactly uniform tile
  is bit-identical to the equivalent fixed-strength filter.
- The GPU plane tests cover ISO 0, 50, 100 and 1600 on 257×65 planes, crossing tile
  and image edges. An alternating-stripe case independently predicts the normalized
  result using 20 equal neighbors, 28 opposite-stripe neighbors and the center;
  its existing 1e-7 tolerance is retained across interpolation and range boundaries.

### Synthetic local-adjustment golden

The committed 64×48 local spatial golden also exercises luminance NLM. The preceding
renderer reproduced it exactly. The corrected candidate changes 766 of 9,216
channel samples, with a maximum difference of 10,370 counts in the 16-bit encoding.

A separate direct implementation used f64 patch distances, full exponentials and
f64 normalized accumulation, with the same declared self-weight rule and floor.
All surrounding stages, mask geometry and the XMP were fixed. This independent
result differs from the candidate at only ten channel samples, by at most one
count out of 65,535. It also differs from the old golden by 10,370 counts.

The synthetic golden is therefore refreshed for the intended kernel correction,
with its **128-count tolerance unchanged**. Its checkerboard and masked magenta
structure were inspected. This synthetic evidence does not establish Adobe parity.

## Results before the output-version bump

The frozen candidate built on `98c4a6799b632c24f6ddefe6b20d37af2936c9b7` has CLI
SHA-256 `04c548f85dc1bc01e8907876d5ac2933bd666b08c37189a9310ffbb8165d162f`.

| Check                                                              | Result                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Focused NLM tests                                                  | 17 passed                                                   |
| Full raw-core library with independently verified synthetic golden | 2,803 passed; 99 existing fixture-gated ignores             |
| Full raw-gpu library on Metal                                      | 285 passed; four existing ignores                           |
| Canonical table reproducibility                                    | Passed with the generator emitting rustfmt-identical output |
| Warm GPU pool allocations                                          | Zero in every measured frame                                |

Interleaved release CPU measurements at 1.024 MP, four Rayon workers and color NR 25
gave candidate medians of 33–40 ms versus 30–45 ms for the preceding implementation.
GPU stage completion, including execution and excluding CPU readback, was broadly
comparable at 1.5 and 2.46 MP. These measurements paused this task's render/comparison
workers and left other applications running. They are relative stage evidence;
full editor input-to-publication latency remains unqualified.

The continuous-tail candidate completed 82 physical comparisons: 78 passed and four
inherited failures remained. All 20 Auto baselines and ten native-detail comparisons
passed, no required cell was missing, and all 258 inputs were unchanged. The four
remaining failures are Panasonic exposure-min, saturation-min and tint-min maxima,
and Sony baseline RGB bias. The earlier ISO-only candidate had the same four
failures. This subset does not stand in for the complete physical gate.

## Remaining acceptance

Current-source qualification after the output-version bump passes 2,803 core
tests, 285 Metal tests, hue/color-chart tests, and all synthetic-grey, adjustment
and DCP gates. The full physical run retains 806 comparisons and hashes all 2,954
inputs before and after execution.

Expanded binding tests exposed an additional oracle metadata mismatch: the C-FFI
sampling test used ISO 0 while its ABI input used ISO 100. Its expected render now
uses the input's declared ISO, preserving the 1e-6 tolerance. The full WASM suite
also exposed a parallel empty-film identity failure; the same test passes in
isolation. Its cache/fit attribution remains open and is not waived here.

The complete physical corpus, current-source binding/parity checks, editor latency
and fresh CI/review must pass before this repair branch can merge. The original
color failures outside this repair remain part of that requirement. No budget was
raised and no failing physical cell was removed.
