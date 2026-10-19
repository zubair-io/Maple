# Preserve native reference-luminance bands in Auto fit selection — #5000

The frozen4cf diagnostic PNG for0011 is byte-identical to its full physical run. Native operator samples reproduce the two new failures: bright-band full-frame B MAE0.04487→0.05197 and inner-window G bias−0.03935→−0.08884. There are1805sampled bright pixels(443heldout),392inside the exact inner80%window(95heldout). Whole-frame improvements cannot establish safety for either subset.

Track whether each sampled JPEG coordinate lies inside the legacy crop, using the same ties-even rounded borders. Add five native reference-luma-band absolute RGB means and the inner-window signed means to step selection, preventing a previously passing0.05check from becoming a failure. Use all native samples for these band moments to reduce sampling noise; the separate native global MAE/MSE safeguards remain strictly heldout. Already-failing metrics remain subject to the unchanged physical gate with no waiver.

Compensated sums prevent numerical accumulation from inventing a threshold crossing for an exactly safe synthetic band; no epsilon or budget was added. Independent witnesses reject cancellation within a native band and inner-window bias damage hidden by improved full-frame absolute error. Exact window bounds/ties-even cases and existing failed-band behavior are covered.76Auto tests pass(sixexistingignored). A fresh physical run qualifies this source; no passing outcome is assumed.

All16JPEG fixtures and4exactAuto==Neutral fallbacks remain in scope. Keep NeutralAgX,versions37/7,sourcebytes,externalchecks/budgets andcomparisongeometry unchanged. Draft5003only; keep pushing and do notmerge or chase main.
