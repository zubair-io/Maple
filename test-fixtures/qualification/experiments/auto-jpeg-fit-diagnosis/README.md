# Auto JPEG fit diagnosis — #5000

Owner direction: prioritize12Auto-to-JPEG failures; remove ACR comparison gates.
Production remains source95fc03d6/output37/fit7; no numerical processing change.
The new standalone `raw-core/examples/auto_jpeg_fit_probe.rs` measures the same
pinned default-model prefix against the original embedded preview. Its names
use the historical structured solver API; it does not read Adobe references.

The three worst physical JPEG failures (0017,0015,0012) fit successfully.
All three already breach the unchanged0.05 per-band limit in the direct fitted
model, before LUT baking or interpolation. For0017 the worst direct-model
bias is0.3414; baked LUT before pixel averaging is0.3381; physical PNG is0.3373.
For0015 those values are0.2254/0.1947/0.1968, and0012 is0.1759/0.1749/0.1729.
These are component diagnostics, not new physical-gate passes. Integer-span
fit sampling differs from Pillow's BOX physical comparison; direct model
clamping also differs from the bake's intentional soft highlight shoulder.
Do not interpret every small diagnostic difference as a LUT bug.

The main error for these three exists in the model's JPEG fit. Merely making
the LUT denser cannot clear it. Shadow bands are too bright and highlights too
dark relative to the camera JPEG, despite a successful fit. Neutral's AgX
appearance remains intentional; the correction belongs in Auto's residual fit.
Further attribution must separate sparse neutral support, fitted objective
and model constraints before changing coefficients or adopting an algorithm.

All12failures have now been probed, preserving completed cases. Every direct
model already breaches0.05 (worst biases range0.0591–0.3414).
`complete-diagnosis.json` joins these component measurements to the immutable
physical JPEG gate. The separate curve-only counterfactual clears0012 but
leaves0017 at0.0504 and0015 at0.0648, so it is not adopted. Current defaults
still have12JPEG failures; no diagnostic result changes that physical count. A boundary/empty-band unit check for the probe passes, plus13JPEG gate
contract checks. No full-suite rerender, tolerance/reference changes or merge.

Secondary finding:0010also has a large direct-to-baked discrepancy on the
same pair means (B shadow-band bias-0.01209to-0.11307). Native pixel averaging
does not explain that difference. Investigate baking/application mapping as
well as the fitted objective; the direct diagnostic and bake differ in their
intentional highlight shoulder, so do not label the entire gap interpolation
error without isolating those contributions.
