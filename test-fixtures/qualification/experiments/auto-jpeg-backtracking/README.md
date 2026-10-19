# Bounded correction backtracking — #5000

The paired fitter previously tried only the full correction; a local overshoot discarded every useful part. Try fixed fractions 1, 1/2, 1/4, 1/8, 1/16 under exactly the same held-out native RGB/perceptual and display-region safety checks. The first safe actual 33-cube artifact is retained; if none is safe, preserve the existing calibration. Full-step artifacts remain byte-identical. No acceptance budget, source input, AgX transform, output version 37 or fit version 7 changes.

The independent synthetic regression requires a proposed full step to be rejected for local color damage, then proves a smaller useful step passes the unchanged safeguards without moving already-correct channels.

Supporting diagnosis: held-out nearest-color prediction with regional context barely reduces the large tails of 0015/0017; a more complex local color model is not yet supported by this evidence. Feature registration on all 16 images finds real geometric differences in several fixtures. Registration is a diagnostic only, never applied by the harness, and cannot be counted as passing image quality. Physical qualification follows.
