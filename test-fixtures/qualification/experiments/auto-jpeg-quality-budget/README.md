# Selecting Auto proposals by fixed quality budgets — #5000

92Auto units pass(six existingignored); release build succeeds. Full physical20, host/GPU/banding and visual qualification pending. Current previous complete renderer7cfe2b6e0d remains5JPEGpasses/11failures/4exactfallbacks/0errors with one0017tile regression relative27f. Goal remains incomplete, draft5003; do notmerge.

Cached0015 evidence in the population checkpoint shows a registered proposal reduces all heldout channel MAEs, scored failures149→141 and worst normalized violation3.655→3.286, without new scored failures. Its larger MSE and already-failing DEp95 veto it under the previous internal Pareto criterion. Gradient was not represented in that diagnostic; no physical pass was claimed.

Selection now scores native per-luminance-band absolute/signed errors, all64display tile/channel absolute errors, display perceptual mean/p95 and RGBp95 against their unchanged0.05/0.1/5/10 limits. An increase in an already-failing DEp95 or in squared error is admissible only when the largest scored budget violation strictly decreases. Heldout channel MAEs still must improve; passing DEp95 cannot worsen; RGBtail/region, nativeband/signed and sample-coverage protections remain. Fitting model, projection constraints, observation geometry, physical gate, all external thresholds, NeutralAgX, output37 and fit7 remain unchanged. The physical gate, including clipping and gradients, still decides actual qualification.

New independent tests cover strictly smaller worst violation, rejection of equal/worse maximum, protection of passing perceptual tails, all regions/channels/native scores, and a synthetic fewer/smaller-failures correction that an already-bad tail used to reject.
