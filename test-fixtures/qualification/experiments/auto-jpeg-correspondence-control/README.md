# Geometry-only lens control — #5000

Uses the existing Neutral profile and --lens off on immutable raws0017/0012. No product defaults or image-comparison policy changed. RootSIFT/affine registration is diagnostic only; none of its output is accepted as a color pass or applied to the harness. Full output PNGs remain external.

0017: default source-to-JPEG scale1.01719; lens-off1.00401 with3,360inliers and0.511px p95 affine residual.0012: default0.98707; lens-off0.99398 with863inliers. Lens correction explains part of the mismatch, while RAW/JPEG crop differences remain. Real color errors also remain after diagnostic alignment. The user has been asked whether to compare common coordinates while retaining lens corrections and fixed color/detail limits, or make product framing match JPEG. That question is pending; do not change geometry policy without the answer.
