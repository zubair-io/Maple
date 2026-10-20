# Bounded correction backtracking — #5000

The paired fitter previously tried only the full correction; a local overshoot discarded every useful part. Try fixed fractions 1, 1/2, 1/4, 1/8, 1/16 under exactly the same held-out native RGB/perceptual and display-region safety checks. The first safe actual 33-cube artifact is retained; if none is safe, preserve the existing calibration. Full-step artifacts remain byte-identical. No acceptance budget, source input, AgX transform, output version 37 or fit version 7 changes.

The independent synthetic regression requires a proposed full step to be rejected for local color damage, then proves a smaller useful step passes the unchanged safeguards without moving already-correct channels.

Supporting diagnosis: held-out nearest-color prediction with regional context barely reduces the large tails of 0015/0017; a more complex local color model is not yet supported by this evidence. Feature registration on all 16 images finds real geometric differences in several fixtures. Registration is a diagnostic only, never applied by the harness, and cannot be counted as passing image quality. Physical qualification follows.

## First physical run

Source f1e72c2480: complete20-fixture run, 3 JPEG passes/13 failures, 4 exact fallback passes, zero errors. 0009 mean display ΔE improves2.0883→1.4557; two red regional MAE checks remain0.05163/0.05321 vs unchanged0.05 limit. No new passing fixture is claimed. Sensor-gain regression remains unfinished. The next experiment refines the accepted/rejected step bracket, retaining every original selection check.

The full f1e72c2480 comparison also detects15 new strong-quality subcheck breaches in0015 and1 in0007 versus ed6424ae59. These are not accepted regressions; this checkpoint remains unqualified despite average improvements.

Refinement bisects the rejected/accepted step bracket eight times; every retained artifact independently passes the unchanged selector. The synthetic test also rejects a slightly larger step, so a regression to coarse halving is detected. Actual image acceptance remains the independent fixed harness.
