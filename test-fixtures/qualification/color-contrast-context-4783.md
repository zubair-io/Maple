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

These controls clear zero canonical physical failures. They narrow the next
implementation work; the broader color gate remains incomplete.
