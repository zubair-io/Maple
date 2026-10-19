# Paired-pixel Auto candidate — #5000

After fixing the gate and replaying every saved fixture, evaluate a lower-complexity fit against actual pixel correspondences. Fit 17-knot per-channel curves with squared pixel error, curvature regularization, a weak identity prior and isotonic projection with a strictly positive slope floor. Bake into the existing 33-cube artifact. No band-mean targets are used.

One quarter of evenly sampled correspondences are withheld from fitting. Select the candidate only when its held-out squared error improves without worsening any RGB channel versus the existing structured LUT. This internal model-selection check is not physical or visual qualification. Existing structured behavior remains when selection fails.

Three synthetic checks pass: identity preservation, learning a smooth monotone paired mapping without flat gray ramps, and rejection of invalid/undersized data. Physical renders, all-fixture evaluation, host/GPU parity and banding remain pending. No image is claimed fixed yet. Pipeline output 37, Auto fit 7 and Neutral AgX remain unchanged. Keep draft5003 unmerged.
