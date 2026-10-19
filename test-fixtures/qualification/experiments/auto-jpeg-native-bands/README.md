# Preserve native reference-luminance bands in Auto fit selection — #5000

The frozen4cf diagnostic PNG for0011 is byte-identical to its full physical run. Native operator samples reproduce the two new failures: bright-band full-frame B MAE0.04487→0.05197 and inner-window G bias−0.03935→−0.08884. There are1805sampled bright pixels(443heldout),392inside the exact inner80%window(95heldout). Whole-frame improvements cannot establish safety for either subset.

Track whether each sampled JPEG coordinate lies inside the legacy crop, using the same ties-even rounded borders. Add five native reference-luma-band absolute RGB means and the inner-window signed means to step selection, preventing a previously passing0.05check from becoming a failure. Use all native samples for these band moments to reduce sampling noise; the separate native global MAE/MSE safeguards remain strictly heldout. Already-failing metrics remain subject to the unchanged physical gate with no waiver.

Compensated sums prevent numerical accumulation from inventing a threshold crossing for an exactly safe synthetic band; no epsilon or budget was added. Independent witnesses reject cancellation within a native band and inner-window bias damage hidden by improved full-frame absolute error. Exact window bounds/ties-even cases and existing failed-band behavior are covered.76Auto tests pass(sixexistingignored). A fresh physical run qualifies this source; no passing outcome is assumed.

All16JPEG fixtures and4exactAuto==Neutral fallbacks remain in scope. Keep NeutralAgX,versions37/7,sourcebytes,externalchecks/budgets andcomparisongeometry unchanged. Draft5003only; keep pushing and do notmerge or chase main.

## Complete physical result — not accepted

Source9ce4ed5858:5JPEG passes,11failures,4exactfallbacks,0errors. All20RAW hashes,16referencePNG hashes and frozenbinary hash match. Allfivepassing photographs remain byte-identical to4cf. Comparing every gatefamily against clean ed6424ae59: no new display or native absolute breaches, but0011still introduces signed G bias−0.052787 in reference band0.50–0.75. The native B regression is cleared; signed G remains failed.76Auto tests,8host/cache,7GPU and5fixed-budget banding ramps pass; they do not waive that failure.

The line search refines to a sampled band boundary, which is too close to safely predict the full pixel population. The follow-up preserves the original global/display refinement, then backtracks a band-limited correction by halves without refining back to the noisy band boundary. A new independent synthetic witness verifies the first safe interior step. This follow-up has its own frozen qualification; no result is assumed here.

Cached objective-reweighting probes are rejected diagnostic leads, not production changes or physical passes. Balanced native/display pixels leave innerbright bias beyond0.05; adding signed moments damages native bright-band absolute errors; threepixel families increase a displayregionby0.844DE, and native/inner-onlyby1.600DE, beyond the unchanged0.1selection margin. Larger loss weights are not an established fix.

Unequal stratification cells also bias unweighted band estimates: nativeJPEG1616×1080cells range24–35pixels. Weighting the392sampledinnerbright pixels by their cell populations changes estimatedbaseline G bias−0.03935→−0.04126, closer to physical−0.04235, but residual sampling uncertainty remains. This diagnostic is preserved; population-weighted fitting/validation is not yet implemented or claimed. No external metric, budget, geometry policy or source byte changed.
