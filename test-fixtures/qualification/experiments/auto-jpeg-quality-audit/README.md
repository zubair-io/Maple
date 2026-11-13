# Rejected Auto calibration: complete-fixture audit

The owner rejected the visually degraded calibration. The production Auto module is restored byte-for-byte to commit f945dd3f4d, before any band calibration. Neutral, no-preview fallback, shader application, pipeline version 37 and Auto fit version 7 are unchanged. The removed implementation remains in Git history.

This audit covers all 16 JPEG-bearing fixtures, including the four original passing controls, and explicitly lists all four missing previews. It uses the saved immutable original and rejected-calibration PNGs. The reference hashes must match before measuring. No original RAW or reference is modified.

At the diagnostic 1024px display scale, mean absolute RGB error increases for 6 of 16 images. This is not a visual acceptance count: lower average error can still hide posterization, clipped regions, and incorrect local colors. All 16 require visual review. The gallery now labels the middle column REJECTED and includes every JPEG-bearing fixture.

## Harness defect

The existing gate only checks 15 signed means (five reference-luma bands by three channels). Errors of opposite sign cancel, and spatial structure within each band is discarded. Fitting LUT nodes to those exact 15 means overfits the test and does not establish photographic quality. Monotonicity and a few synthetic ramps did not prevent real-image regressions.

The saved synthetic witness has zero signed bias but mean absolute error 0.2. It demonstrates the false positive independently of any camera or lens registration.

## Remaining work

The original 12 signed-bias failures remain unresolved. The image-quality gate is not repaired by this audit. Before accepting another processing change, establish spatial alignment and color-space handling, add non-cancelling per-pixel/region color and luminance checks plus clipping and gradient/detail checks, and qualify their ability to reject the saved defective outputs. Include full-frame review (the old 10% border exclusion hid edges), all original passing controls and separate no-preview Auto-to-Neutral fallback checks. Fit against image correspondences and independent photographic constraints, not only the aggregate acceptance statistics. No new acceptance thresholds are invented in this diagnostic chunk.

Keep draft PR #5003 open and unmerged. Prior numerical receipts are preserved but explicitly marked rejected for image-quality qualification. No complete-fix claim remains valid.

## Rollback verification

The complete `src/raw-pipeline` tree matches f945dd3f4d exactly. Auto unit checks after rollback: 51 pass, 0 fail, 6 existing ignored. These checks establish the rollback, not repaired JPEG image quality. No new physical rerender or GPU qualification is claimed.
