# Auto/JPEG harness repair — #5000

The old signed band means remain at the unchanged 0.05 limit. They are now
necessary but insufficient: the canonical runner and direct comparator both
also enforce the same full-frame quality checks. There is no per-camera budget,
exposure/color compensation, content alignment search, or reference substitution.

## Fixed additional policy

- At the JPEG comparison grid, non-cancelling full-frame and reference-luma-band
  absolute RGB means must each remain within 0.05 per channel. This also catches
  errors that would disappear when reduced to display resolution.
- At a maximum 1024-pixel display long edge, absolute per-channel means over the
  whole frame and every cell of an 8-by-8 grid must remain within 0.05. All image
  borders are included. The original bias check retains its original inner crop.
- Per-channel absolute-error p95 must be at most 0.10; perceptual CIEDE2000 mean
  at most 5 and p95 at most 10. These are additional conservative engineering
  limits, not an assertion that all errors below them are invisible. The latter
  values also match the repository's existing Apple golden mean/p95 limits.
- No more than 1% of a channel's pixels may newly reach black/white while the
  reference is more than 0.05 away from that endpoint. Each channel is checked.
- Mean absolute horizontal/vertical gradient discrepancy is limited to 0.05 per
  channel at display scale. This complements, rather than replaces, native
  smoothness/banding and host/GPU parity checks.

These additional limits were fixed before color-fit changes. They are not fitted
per fixture and may not be loosened to obtain passes. Geometry/lens mismatches
must be diagnosed explicitly. The only geometry normalization is the existing
aspect-center crop and BOX resize; JPEG references are already display-oriented
and decoded to sRGB by the CLI. No new renderer processing was changed here.

## Regression coverage

`test-fixtures/auto-jpeg-quality/` contains lossless 384px diagnostic derivatives
of all 16 JPEG-bearing fixtures: original Auto, rejected calibration and embedded
JPEG, with derived and original-source hashes. These are additional regression
fixtures, not replacements for original RAWs or the physical reference images.
Every pair is checked in fixture-free CI, including all four old passing controls.
Known defective originals and rejected outputs must be rejected; identity controls
must pass. Original/rejected test_0002 and rejected test_0014 remain numeric
positive controls; this does not certify every pixel of their native renders.

Synthetic witnesses independently cover balanced cancellation, alternating-pixel
errors, local/border damage, cast, clipping, posterized ramps, scrambled spatial
content, invalid pixels, and native errors that display reduction could hide.
The direct comparator and canonical shell entry point share the complete policy.

The physical saved-image replay uses the original PNGs and hashes, not the 384px
snapshots. It evaluates both versions of all 16 JPEG-bearing fixtures. No-preview
cases remain distinct from matching passes. On subsequent real runs the runner
renders Auto and Neutral for every previewless RAW and requires exact decoded
RGB equality; a failure is an error, never a skip/pass. This does not make a
previewless fixture a JPEG color match.

No complete color-fix claim is made. Once the replay and regression tests are
committed, work resumes on actual Auto processing against this stricter policy,
with full-corpus visual review and incremental draft pushes. Nothing is merged.
