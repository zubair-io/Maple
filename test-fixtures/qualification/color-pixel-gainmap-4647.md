# Pixel 6 Pro color-failure attribution — #4647

Investigation remains open. The v39 gain-map candidate passed its complete Pixel fixture qualification
except for the existing exposure outlier. v40 completes CA ceiling transport
and is under qualification; neither candidate is accepted for merge.
The original RAW, sidecars, Adobe references and numerical budgets are unchanged.

## Individual camera calibration

The physical DNG has nonidentity diagonal CameraCalibration1/2 and unity
AnalogBalance. Both the DNG's CameraCalibrationSignature and the installed
Adobe Standard DCP's ProfileCalibrationSignature are absent (empty). The
[Adobe DNG SDK](https://android.googlesource.com/platform/external/dng_sdk/+/master/source/dng_color_spec.cpp)
applies camera calibration when those signatures match. Maple folds it into
the embedded ColorMatrix, but bundled-profile selection does not retain it.

A standalone v37-linked probe replaced only the resolved bundled matrices
through the embedded resolver. Its unchanged-matrix control reproduced every
pixel exactly for four as-shot Neutral cases. Applying the physical calibration
to the bundled ColorMatrix moved the inferred render CCT from 5809.67 K to
the estimator's 15000 K ceiling, but cleared none of the three failing cells:

- baseline remains passing (mean ΔE 11.4896 → 11.4876).
- dehaze_max still fails blue bias (mean 12.5165 → 12.5053).
- exposure_max still fails maximum ΔE (53.5709 → 53.5225).
- whites_min still fails mean, p95 and green/blue bias.

All recorded inputs remained unchanged. This is an attribution probe, not a
complete implementation of calibration-signature handling.

## Exposure outlier

Only five of the 12,032,000 compared pixels exceed the unchanged maximum
budget of 34. At comparison coordinate (294,1440), Maple is RGB (95,58,213)
and Adobe is (247,226,224), ΔE 53.5709. The nearby native peak is (299,1463),
RGB (78,40,213) versus (247,224,221), ΔE 58.2737.

Enabling the existing hot-pixel option only in the diagnostic model leaves
the maximum exactly 53.5709. The original sidecar remains Off. This rules out
that existing detector as a remedy; it does not justify changing the default.

A frozen v37 CLI with stage dumping reproduces the original production PNG.
At the native peak, the post-warp, pre-DCP camera RGB is
[.0043931,.0013083,.0264417]. DCP changes it to
[.0034014,.0009647,.0257170]; +5 EV then magnifies the existing chromatic error.
The warp maps the point to approximately (317.7882,1471.4281) in the sensor
frame. The nearest pre-warp, WB-balanced sample is
[.0137986,.0152259,.0203203]; its 7×7 neighborhood spans a strong brightness
edge. Cubic resampling produces substantially lower red and green values than
that neighborhood's minima. The current sampler's separable A=-.75 kernel
and 32-phase table match the SDK design; this evidence does not establish a
wrong kernel. The demosaic/edge interaction still needs attribution.

## Required sensor gain maps

OpcodeList2 contains four **required** GainMap operations (flags zero), one
per Bayer phase. Each has a 30×40×1 lattice, pitch 2×2, origin zero and spacing
[1/29,1/39]. Declared gains span approximately 1.004–4.683. Rawler does not
apply these operations. Before v39, Maple only consumed OpcodeList2 for the
8-bit LinearRaw polynomial path and skipped the Bayer maps.

An independent bilinear lattice evaluation at pixel centers gives an effective
gain range of 1.003684–4.680490. The original sensor has 131 samples at its
declared white level, 16368. Applying the maps after black subtraction yields
a maximum 26464.87 DN above black. **2,037 originally unclipped samples would
cross the old scalar clipping threshold.** Therefore multiplying the mosaic
alone would corrupt clipping evidence. A complete fix must preserve the
sensor saturation domain through demosaic and highlight recovery, including
full, sized and tile preparation. It must not clamp the corrected scene range.

## v39 candidate and qualification

The parser preserves operation order, sensor-plane selection, AreaSpec pitch,
ActiveArea origin and pixel-center bilinear evaluation. It rejects malformed
payloads and unsupported required mosaic operations. All 12,533,760 physical
sample gains match an independent evaluation within 9.54e-7.

A separate range-expanded integer diagnostic applies the gain maps without
clipping amplified sensor values. Both its unchanged-gain control and its
candidate change the scalar saturation ceiling, so this probe cannot qualify
production highlight handling. It records:

| Case         | Control mean ΔE | Gain-map mean ΔE | Candidate breaches |
| ------------ | --------------: | ---------------: | ------------------ |
| baseline     |         11.4919 |           9.1548 | none               |
| dehaze_max   |         12.5171 |          10.5863 | none               |
| exposure_max |          6.6796 |           5.1379 | max 51.1875 > 34   |
| whites_min   |         10.6708 |           8.6551 | none               |

The actual v39 implementation applies the maps after sensor normalization and
transports local saturation ceilings into AMaZE and highlight recovery. It
preserves measured CFA phases, accounts for the two green samples in half-size
previews, and carries absolute sensor origins into tiles and scene-prior
sampling. The shared GPU camera preparation consumes this same Rust prefix;
no separate shader calibration is introduced. The existing shared ingest
consumer receives the same highlight-ceiling metadata; no panorama feature
work is included.

Nine initial tests passed, including actual decode, all physical sample
saturation classifications, malformed data, analytical interpolation, phase
and ActiveArea handling, tile origins, HDR preservation, true-clip recovery,
and AMaZE measured-channel preservation. An additional plane-range regression
is included in the subsequent domain qualification.

Frozen production CLI SHA-256:
`cdc2dcc549f3126494c36d7a7d41068743b1e056599cb6db07cea0abb8ba3b95`.
Pipeline output version 39, Auto-fit version 11. The complete Pixel run measured
44 unique cells (43 Neutral cases plus Auto baseline): **43 pass, one fails**.
`dehaze_max` and `whites_min` pass without new Pixel failures. `exposure_max`
remains over its maximum budget: 51.187453 > 34, with four compared pixels
above 34. All ten native-detail cases and the Auto baseline pass. All 163
input hashes remain unchanged; no unique case was skipped or missing.

All 16 domain gates pass, including physical GPU camera coverage, actual
browser-target compilation, core/GPU/WASM/FFI suites, grey/DCP, banding,
SIMD witnesses and headroom. The before/after source audit is unchanged.
Subsequent full/tile checks pass: 18 synthetic comparisons across Full,
Amaze and Preview with recovery Off/On, plus four native Pixel tiles, are
bit-identical. An initial physical tile assertion used DefaultCrop-relative
coordinates in a sensor-relative API; correcting that test conversion fixed
the assertion without a runtime change.

v40 transports the actual fitted automatic lateral-CA field into gain-map
saturation ceilings. It uses the same source-coordinate helper as the mosaic
resample, matching Bayer phase, border clamping and delta-form bilinear
interpolation. The context is retained through full/half demosaic and recovery,
without allocating a calibration raster. The Pixel corpus authors automatic CA Off, so this interaction does not
explain its remaining exposure failure. Its vendor warp uses one coefficient
set; per-plane vendor CA does not suppress the automatic option for this file.
All 18 v40 domain checks pass with an unchanged source audit. This includes
13 targeted CA tests, exact gain transport for all four Bayer patterns, an
actual estimated-field full/half camera-prefix oracle, physical full/tile
checks, the complete core/GPU/WASM/FFI suites and browser compilation.
The complete v40 Pixel gate again passes 43/44 unique cells, with no errors
or missing cases and all 163 input hashes unchanged. The exposure maximum
is unchanged at 51.187453. Frozen v40 CLI SHA-256:
`0e66c92f79ad07a80af6e908ef91a44d6cf81c2b7a83fc86b7fe973f0995912a`.

An interleaved release microbenchmark on all 12,533,760 Pixel sensor samples
measures median linearization at 13.98 ms with maps versus 3.37 ms without
maps, excluding its warm-up round. This runs during concurrent qualification;
it measures only sensor linearization and does not qualify complete editor
latency or highlight recovery. Gain evaluation adds no work to cached slider
ticks. Whole-corpus acceptance and remaining performance gates are pending.

The residual exposure artifact is tracked separately by #4650. Fresh Adobe
control captures reproduce the authored reference pixel-exactly. Existing
alternative demosaic choices, stronger Color NR, and disabling the existing
FCS blend each fail the unchanged exposure maximum. None is adopted.
Demosaic and resampling interaction experiments remain diagnostic only.

Evidence for the range-only diagnostic:
`/Volumes/Projects/maple-color-gate-20261015/pixel-gainmap-range-attribution/`.
Production qualification:
`/Volumes/Projects/maple-color-gate-20261015/pixel-gainmap-v39/`.
Acceptance remains tracked by #4647; no numerical budget has changed.

Evidence: `/Volumes/Projects/maple-color-gate-20261015/pixel-calibration-attribution/`.
The directory contains the four-case identity audit, byte-identical resolver
controls, hot-pixel diagnostic, all 32 stage EXRs, native/comparison outlier
coordinates, opcode bytes, exact lattice values and sensor-domain statistics.

## Highlight recovery scan performance

The unchanged v40 release benchmark initially failed the sparse 2 MP 4 ms
ceiling in two of three controlled runs (5.272, 5.030, 3.383 ms). The large
partial-clip block passed its 12 ms ceiling in all three runs. Those results
were not accepted as a performance pass.

Separating constant-ceiling mask scans from calibrated scans lets the compiler
specialize the common path without sensor-coordinate calculations. The same
mask rules, arithmetic, witness selection and reconstruction are retained.
An exhaustive mask oracle covers all 1,728 combinations of signed, finite,
nonfinite, near-ceiling and clipped channel values, two ceiling triples,
three regions and both absent and spatial calibration. All 41 highlight
correctness tests pass, including the expanded oracle.

Five interleaved release runs pause only this investigation's rendering jobs
and resume them in a finally block. Candidate sparse timings are 2.750, 2.519,
2.578, 2.632 and 2.581 ms; all pass 4 ms. The unchanged v40 control measures
4.448, 3.521, 3.400, 3.386 and 3.491 ms, with one failure. Both variants pass
the existing 12 ms large-block test in all five rounds. No benchmark assertion
or numeric ceiling changes. These stage measurements do not establish the
complete editor slider budget or full physical acceptance.

Exact identities, interleaved logs and controlled-job records are in
`pixel-gainmap-v40/hr-performance-split/` under the evidence root.
