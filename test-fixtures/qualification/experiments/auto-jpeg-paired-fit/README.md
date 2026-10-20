# Paired-pixel Auto candidate — #5000

After fixing the gate and replaying every saved fixture, evaluate a lower-complexity fit against actual pixel correspondences. Fit 17-knot per-channel curves with squared pixel error, curvature regularization, a weak identity prior and isotonic projection with a strictly positive slope floor. Bake into the existing 33-cube artifact. No band-mean targets are used.

One quarter of evenly sampled correspondences are withheld from fitting. Select the candidate only when its held-out squared error improves without worsening any RGB channel versus the existing structured LUT. This internal model-selection check is not physical or visual qualification. Existing structured behavior remains when selection fails.

Three synthetic checks pass: identity preservation, learning a smooth monotone paired mapping without flat gray ramps, and rejection of invalid/undersized data. Physical renders, all-fixture evaluation, host/GPU parity and banding remain pending. No image is claimed fixed yet. Pipeline output 37, Auto fit 7 and Neutral AgX remain unchanged. Keep draft5003 unmerged.

## Curve-only candidate rejected

All three focused physical cases (0005, 0015, 0017) fail the fixed quality gate.
There are no clears. Visual inspection shows insufficient contrast and unwanted
color changes, particularly 0017. 54 Auto unit tests pass, 6 existing ignored;
this does not override the physical failures. The source is archived as
`rejected_curve_fit.rs.txt`. The existing Auto1 full curve+residual diagnostic
also fails all three. No claim is made for other fixtures from these pilots.

The next controlled experiment removes the band-mean curve preprocessing and
fits the existing confidence-damped, smoothed full RGB LUT directly from pixel
pairs. It uses the same 33-node artifact and a separate quarter of pairs for
selection against the structured baseline. This checks whether channel-separable
fit or band-curve preprocessing is starving cross-channel color corrections.
