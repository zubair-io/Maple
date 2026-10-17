# Image-dependent contrast response — #4783

The #4645 calibration candidate clears 24 physical failures and introduces
eleven, including minimum contrast on all three cameras. These diagnostics
separate camera-profile, detail-processing and image-population effects before
changing Maple's fixed AgX contrast pivot. No rendering change is adopted.

## Profile controls

The installed Adobe Standard profiles for GFX 50S, GFX 50R, Leica M10 and Sony
A7R IV contain no `ProfileToneCurve`. Their `ProfileLookTable` payloads are
byte-identical (SHA-256
`4b5cf5fd5f61e2630acf62a27f4585c414506b56bd81cc7b36198418a19f8271`),
with saturation and value coefficients exactly one on the neutral axis.
This does not support a camera-specific tone-curve explanation for the
different contrast crossings. All four source DCP hashes remain unchanged.

## Separate detail from the global response

The native-pixel audit samples every fourth row/column without resizing. It
groups exact baseline RGB triples, selects near-neutral values away from
clipping, and requires at least 64 observations per group. Its statistic is
the 10th-to-90th percentile spread of encoded Rec.709 luma in code values;
it is a diagnostic, not a replacement for CIEDE2000 or the physical gate.

| GFX 50R / test_0012                                          | Minimum contrast | Maximum contrast |
| ------------------------------------------------------------ | ---------------: | ---------------: |
| Largest spread with canonical detail settings                |           8.0706 |          14.8596 |
| Largest spread with sharpening and both NR controls disabled |           1.0000 |           1.4304 |
| Supported exact-RGB groups, canonical                        |            1,374 |            1,374 |
| Supported exact-RGB groups, detail disabled                  |              927 |              927 |

The detail-disabled controls use one isolated copy of the original RAW and
three ACR renders, each saved at full and down resolution. All six PNGs pass
effective-settings verification. Original RAW/sidecar and copied RAW hashes
remain unchanged. The pixel populations differ between variants because detail
changes the baseline; this is not a per-group paired reduction claim.

The neutral response's zero crossing remains approximately 0.57 in encoded
luminance: canonical minimum/maximum are 0.57210/0.57281, versus
0.57056/0.57005 with detail disabled. Thus the large within-image spread does
not justify a local contrast filter, while a global response difference remains.

## Hold the ramp and calibration fixed; change the surrounding population

Three synthetic 512×512 LinearRaw DNGs use the same GFX 50R CM/FM pairs,
illuminants, As Shot neutral and zero baseline exposure. Their central 256×256
neutral ramp has an identical sensor-sample hash. Only the surrounding neutral
signal changes: 0.005, 0.18 or 0.7. ACR uses the same explicit Adobe Standard
profile and tone settings, with sharpening and both NR controls disabled.
Contrast -100, 0 and +100 produce nine verified PNGs.

| Surrounding signal | Minimum-contrast crossing | Maximum-contrast crossing |
| ------------------ | ------------------------: | ------------------------: |
| 0.005              |           0.35294–0.35686 |                   0.35599 |
| 0.18               |                   0.60392 |                   0.60392 |
| 0.7                |                   0.72157 |                   0.71633 |

Crossings use the median across central ramp rows. Repeated crossings indicate
an 8-bit zero plateau, not separate curve roots. In an interior region that
excludes the surround boundary, middle-versus-dark baseline pixels are exact;
bright-versus-dark differ by at most one code value. The same comparisons at
minimum contrast differ by up to 28/38 values; maximum contrast by up to 40/52.
All generated DNGs, calibration inputs and sidecars retain their hashes.

This isolates an image-context dependency in Adobe's global contrast response.
It does not identify the internal formula, demonstrate a Maple correction or
justify camera-specific constants. A replacement still needs a validated
population-based model, CPU/GPU parity, frame-time qualification and the full
physical corpus at unchanged numerical limits. Auto remains the default.

## Hold the population fixed; change its arrangement

Three further charts preserve the full input histogram and central ramp exactly.
The surrounding population is half 0.005 and half 0.7. Bright samples occupy
the nearest half of the surround, the farthest half, or a one-pixel checkerboard.
All nine Adobe renders pass settings and source-integrity checks.

Moving the bright population from near to far leaves baseline interior pixels
identical and changes either contrast extreme by at most one code value.
The checkerboard also has identical baseline interior pixels, but changes
minimum/maximum contrast by up to 13/18 values. An unsmoothed histogram alone
therefore does not explain the response.

Eight additional charts vary checker block size and phase while retaining the
same input histogram and ramp. All 24 Adobe renders pass settings verification.

| Checker arrangement              | Minimum-contrast crossing | Maximum-contrast crossing |
| -------------------------------- | ------------------------: | ------------------------: |
| One pixel, either phase          |                   0.61961 |                   0.61569 |
| Two pixels                       |                   0.61961 |                   0.61569 |
| Four, eight, 16, 32 or 64 pixels |                   0.50588 |                   0.50980 |

The one-pixel phase reversal and two-pixel pattern produce identical interior
pixels for all three contrast settings. Four-pixel and larger blocks differ
from the one-pixel control by at most one baseline code value, versus 14/20
at minimum/maximum contrast. This supports investigating spatial reduction
before population measurement; it does not establish a reduction kernel or
justify adding a local contrast filter. Native resolution and offset controls
are still needed before choosing a model.

The replayable analysis reproduces the original output hashes and interior
pixel comparisons exactly. Its equivalent float64 luma reduction differs from
the initial calculation by at most `2.22e-16`. Two-parameter logit fits are
retained as diagnostics only: their errors reach 11.41 code values, so they
are not accepted as a rendering model.

## Image size, sampling alignment and averaging domain

Another 36 verified renders repeat the same samples at 1024/2048 pixels or
shift the 512-pixel four-pixel checker. Enlarging every source sample by 2× or
4× preserves the fine/coarse response split: crossings remain approximately
0.62 versus 0.51. Native block width alone therefore does not determine the
response. The central ramp is unchanged before repetition; cross-size analysis
uses block medians to compare corresponding repeated samples, rather than
claiming native pixel equality at different dimensions.

Shifting the four-pixel checker horizontally by one or three pixels moves its
crossing to about 0.60; a two-pixel shift moves it to about 0.62. Offsetting both
axes produces a similar effect. This is consistent with aligned spatial
reduction before measurement, although it does not prove an internal kernel.

Fifteen further renders replace the fine checker surround with its arithmetic
or power-domain mean. Arithmetic averaging of scene-linear values differs from
the checker response by up to 8.72 code values. Means formed in a gamma 1.8 or
2.0 domain agree with the measured response within one code value. Coarse
quarter-mixture bins formed in the gamma 2.0 domain also agree with the shifted
checker response within one code value. These are response differences
(`edited − baseline`), measured over the corresponding ramp columns. The
8-bit evidence does not distinguish the two close gamma hypotheses.

Allowing both slope and offset in the existing AgX log-coordinate transform
still leaves 3.18–6.13 code-value RMSE across the original six contrast curves.
Thus these controls support a reduced-image brightness statistic, but neither
identify a production statistic nor qualify a pivot-only correction. No
per-camera constant, reference-pixel lookup or rendering change is adopted.

The first chart attempt omitted `NewSubFileType` and produced zero renders.
The DNG SDK rejects that missing tag in `dng_ifd::IsValidDNG`; adding the explicit
main-image value zero fixes the generated format without changing its samples.
The failed attempt and corrected generator are retained separately. See the
[DNG SDK validation source](https://android.googlesource.com/platform/external/dng_sdk/+/80a267ed1ac714acff455e85ae28c1732777d5b6/source/dng_ifd.cpp).

## Evidence and limits

The evidence root is `/Volumes/Projects/maple-color-gate-20261015/`:

- `three-camera-hsm-v47/contrast-profile-audit.json`: source DCP identities.
- `contrast-context-audit/`: four-camera native-pixel groups and unchanged inputs.
- `contrast-context-no-detail/`: physical controls, generator, metadata checks,
  exact-RGB groups and crossing measurements.
- `contrast-context-chart/`: rejected first format attempt; no color evidence.
- `contrast-context-chart-v2/`: corrected DNGs, source generator, sidecars,
  Adobe driver, metadata checks, output hashes and per-column responses.
- `contrast-context-layout/`: identical-population near/far/checker controls.
- `contrast-context-frequency/`: checker frequency and phase controls.
- `contrast-context-sampling/`: repeated-source native-size and offset controls.
- `contrast-context-average-domain/`: averaging-domain controls and response
  comparisons against the fine and shifted checker patterns.

These controls clear zero canonical physical failures. They narrow the next
implementation work; the broader color gate remains incomplete.
