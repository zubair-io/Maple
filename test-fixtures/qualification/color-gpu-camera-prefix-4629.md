# Shared camera-image preparation for GPU — #4629

The sized CPU develop path and the new GPU preparation now call one camera
prefix function. It performs the existing linearization/demosaic, baseline
exposure, As-Shot pre-gain, sensor highlight recovery, lens operations,
DefaultCrop and area reduction, stopping before user WB and DCP. The original
stage bodies and their order are unchanged. Cancellation is checked before
preparation, within the existing expensive kernels and at the new boundary.

`GpuCameraColorimetry::prepare` pairs this image with the resident calibration
and the existing pre-WB Whites statistic. Sampling density and geometry remain
attached to the image. User WB, exposure, HSL, capture sharpening, NR and AE do
not change these camera pixels; their processing belongs downstream. The new
unit test verifies this independence and cancellation on both committed small
DNGs.

## Actual image parity

The physical test prepares and uploads one 512-pixel-long-edge camera image per
fixture, then reuses it for five WB states: As Shot, 8500 K with tint ±150,
temperature-only 8500 K and tint-only +150. Fixtures 0000, 0002, 0006 and 0013
cover Bayer, corrected lossy LinearRaw, HSM and no-HSM profiles. All **20** results
match the actual CPU sized develop at the existing absolute 0.0001 stage limit;
worst observed error is **0.000012636185**. Alpha, dimensions, Whites anchor and
sampling density also agree.

The test isolates this boundary: AE, sharpening, NR and highlight recovery are
explicitly off. It does not claim that the later processing has moved to GPU,
or that a full display render meets Adobe budgets.

A separately frozen executable from parent `09bc504c0d` and an executable after
extraction render the same six RAWs at both Preview and AMaZE quality and both
32/512-pixel caps. All **24** CPU scene pixel hashes and dimensions are identical.
These controls use the existing probe's normal processing defaults, including
sensor recovery, while disabling AE and selecting Neutral. All six RAW hashes
remain unchanged. This is a code-extraction control, not a speed measurement.

## Domain qualification

| Check                                                | Result                                   |
| ---------------------------------------------------- | ---------------------------------------- |
| Full raw-core with GPU                               | 2,824 passed; 102 fixture-gated ignores  |
| Explicit camera/DCP tests, including physical inputs | Five passed; zero ignored                |
| Full raw-wasm with GPU                               | 72 passed; eight existing ignores        |
| Full raw-ffi with GPU                                | 301 passed; six existing ignores         |
| Browser target with GPU, parallelism and AVIF        | Passed on pinned nightly                 |
| File headroom                                        | Passed                                   |
| Source/RAW identity audit                            | Five source files and six RAWs unchanged |

## Integration status

The shipping live hosts still use their existing post-DCP upload entry point.
The camera prefix and fused DCP stage are complete prerequisites under #4629;
AE, intermediate spatial processing, remaining baked controls and binding/cache
contracts must move before the hosts can switch. No per-tick CPU re-develop or
image readback has been introduced. Pipeline output remains version 35 because
existing CPU and live output behavior is unchanged.

Source snapshots, before/after executables and pixel ledgers, physical stage
comparisons, domain logs and identity audits are in the task's
`camera-prefix-stage` archive. No original RAW, XMP, reference, required case or
numerical color budget changed. This step does not reduce the recorded count of
end-to-end failures by itself.
