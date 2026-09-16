# Sensor ActiveArea regression — #3680

Moving highlight reconstruction before DefaultCrop exposed masked sensor samples
to its neighborhood estimator. Decoding preserves the full sensor rectangle;
black subtraction does not guarantee zero optical-black residuals. The physical
ActiveArea is already retained in `RawImage.lens_metadata.active_area`, including
images without OpcodeList3.

## Executed red/green control

The integration fixture decodes a synthetic DNG with real embedded colorimetry,
then supplies a 24×24 high-bit-depth LinearRaw buffer with identical active scene
pixels and two different masked borders. LinearRaw isolates reconstruction from
demosaic interpolation. The physical ActiveArea is 16×16 at (4,4); the borders are
zero versus positive channel-dependent residuals `[0,20,10] / 10000`.

Both full and sized (8-pixel long edge) HR-Off controls are identical. Before the
fix, ChromaticAdaptation changes the scene by maximum **0.09095481** full-size
and **0.018495023** sized. Both regression tests fail (zero skips).
After restricting reconstruction to ActiveArea, both pass; the expanded six-test regression suite passes with zero skips. The full
Rust core suite passes **2405 tests, zero failures, 92 existing ignored tests**.
Additional cases verify valid witnesses outside DefaultCrop, unchanged masked
targets, inward half-resolution coordinate rounding and empty-region identity.

## Scope of the correction

Both reconstruction targets and witness reads stay inside physical ActiveArea.
DefaultCrop is not substituted: valid scene pixels outside that recommended
render crop remain evidence. Bounds scale with the actual demosaic divisor;
half-resolution cells straddling a masked border are excluded by rounding inward.
Full, sized and panorama preparation use the same conversion. Tiled preparation
translates the same rectangle into its padded sensor window before the stage
clamps it to the local buffer. No full image copy or per-pixel allocation is
introduced. Unbounded radiance and unchanged known-channel rules are preserved.

The regression proves the estimator no longer reads masked-border samples. It
does not claim that demosaic itself is independent of optical-black borders.
Original files, references and numeric budgets remain unchanged. The previous
ac1431903 platform records and d9e570ace perceptual run precede this correction;
refreshed qualification is required before merging it.
