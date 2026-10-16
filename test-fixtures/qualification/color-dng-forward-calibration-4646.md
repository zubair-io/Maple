# DNG ForwardMatrix calibration — #4646

This is ongoing qualification, not a complete color-gate pass. The local
candidate fixes the diagonal calibration used by the physical Canon DNGs.
The existing non-diagonal path remains tracked in #4646 because it needs
active-white-point calibration in the profile and native WB-frame transport.

## Independent Adobe control

Adobe Camera Raw 18.7 exported an isolated, byte-identical copy of
`test_0010.CR2` to lossless DNG 1.4 (Camera Raw 7.1 compatibility, lossy
compression disabled). Both the source CR2 and staged CR2 remain unchanged.
The exported DNG is a diagnostic input, not a replacement reference or fixture.

- CR2 SHA256: `3ea2d03556747afcafa24f13fee69106f383dfaf3a2f436f8331f14518f20037`.
- DNG SHA256: `7e523274739da92fbfd3c30191892dee16dea4099adc80b7c0b023db1783021b`.
- DNG pixels: 5040×3360, 16-bit RGB, lossless JPEG compression, black 0,
  white 14008, BaselineExposure .36.
- AnalogBalance: approximately [1.983051, 1, 1.477273].
- Both CameraCalibration matrices: diagonal [1.0022, 1, .9836].
- AsShotNeutral: approximately [1, .998698, .9972].

The Adobe decoded samples are close to the original decoded samples times
`AnalogBalance/4`; this independently supports the CR2's fourfold white-level
scale and exposes its inappropriate subtraction of a sensor black offset
from reconstructed RGB. Black-zero alone remains an unadopted diagnostic:
it introduces other canonical bias failures.

## ForwardMatrix ordering

The [Adobe DNG SDK's SetWhiteXY implementation](https://android.googlesource.com/platform/external/dng_sdk/+/refs/heads/android14-prebuilt-test/source/dng_color_spec.cpp)
normalizes the camera neutral in the reference-camera frame before applying
ForwardMatrix. With `C = AnalogBalance × CameraCalibration`, its transform on
unbalanced camera pixels is:

```text
FM × diag(inv(C) × neutral)^-1 × inv(C)
```

Maple's DCP input has already been divided by `neutral`. For diagonal C, the
correction therefore cancels exactly, leaving raw FM. Previously decode folded
`FM × inv(C)` and DCP applied it to the pre-balanced pixels, introducing a
second correction. An actual-tag neutral witness should produce approximately
XYZ [.9643, 1, .8251], but the old two endpoint matrices produce
[.62846, .79469, .52552] and [.61543, .81714, .54116].

The physical runtime witness reproduces that error: a neutral camera input
becomes Rec.2020 [.385375, 1.174947, .540130]. Restoring the raw FM gives
[1.000270, .999922, .999770]. The small residual follows the rounded source
matrices and color-space transforms.

## Isolated physical attribution

These measurements use the same original XMPs, ACR references, comparator,
and numerical budgets. Only the diagnostic Adobe DNG is rendered. The
correction is made in memory; original assets are not edited.

| Case         | Old mean ΔE | Corrected mean ΔE | Corrected result     |
| ------------ | ----------: | ----------------: | -------------------- |
| baseline     |     22.2239 |            4.7057 | RGB bias still fails |
| exposure_min |      3.1647 |             .6045 | Pass                 |
| shadows_min  |     21.0721 |            5.0982 | Pass                 |
| tint_max     |     26.8548 |            6.5738 | Pass                 |
| tint_min     |      9.2730 |            6.3356 | Pass                 |

Both five-case runs completed with unchanged input hashes. These passes do
not clear the original CR2 cases in the full corpus inventory.

## Production candidate

Pipeline output version 37 and Auto-fit model version 9 invalidate artifacts
that depended on the old calibrated DNG scene. The helper returns the exact
raw FM for finite positive diagonal C; identity calibration is byte-preserving.
CPU and GPU preparation consume this shared resolved profile matrix, so no
independent shader formula is introduced. The preexisting non-diagonal fold
is explicitly retained under #4646 pending complete transport support.

The frozen production v37 CLI reproduces all five in-memory diagnostic results
(4 pass, baseline RGB bias fails), with every recorded input hash unchanged.

Three new regressions pass: an independent scalar SDK predictor across
calibration/neutral/colored-HDR sample combinations, the actual Canon neutral
witness, and synthetic DNG decode through DCP.

All 15 v37 domain gates pass, with source and physical input hashes unchanged:
2,834 core tests, 292 GPU tests, 74 WASM tests and 301 FFI tests; explicit
physical camera/DCP and HSM tests; the actual browser target; 49 WGSL modules;
gray, adjustment and DCP gates; all 90 banding cases; the WASM SIMD witness;
one-shot WB parity and source headroom. Existing fixture-gated ignores remain
102 core, five GPU, eight WASM and six FFI.

The frozen physical run completed all original test_0006/test_0007 cases:
86 manifest cases, 88 comparisons, zero missing required cells/errors, and
326 unchanged input hashes. Eight cells fail. The six v32 failures remain;
test_0006 baseline and highlights_min newly breach blue bias (.0293 > .0289
and .0571 > .0554). Both Auto baselines pass. The calibration fix therefore
remains unaccepted for merge pending the color-gate repair.

The unrelated bundled-HSM candidate was withdrawn after its own broader
regressions. Current output 38 / fit model 10 retains the diagonal correction
and restores the old bundle; its source qualification is separate from v37.

Evidence is archived under
`/Volumes/Projects/maple-color-gate-20261015/canon-sraw-cross-decoder/` and
`/Volumes/Projects/maple-color-gate-20261015/dng-forward-v37/`.
