# Keep native-band corrections inside sampled feasibility — #5000

The native band guard cleared0011's new absolute B error, but refining to its estimatedsigned-band boundary left the actual G bias at−0.052787, past the unchanged0.05limit. Sampled moments are estimates, not physical acceptance evidence.

First retain the existing global/native/display safety selection and its useful refinement. Then, only if that selected artifact violates a native band check, halve the correction until every safeguard passes. Do not refine back toward the sampled band boundary. Safe existing artifacts remain unchanged. All earlier native RGB, regional/perceptual and display RGB guards remain; every actual physical limit remains mandatory.

An independent synthetic case passes the original safeguards but violates a native bright-band limit. It must keep the first safe half-step rather than approach the band threshold.77Auto tests pass(sixexistingignored). Existing backtracking, zero-residual, exactfootprint, already-correct-channel and localdamage witnesses remain. Full all20physical qualification follows under its own source/hash. Keep all16JPEGs and4separate exactfallbacks,NeutralAgX,versions37/7,sourcebytes,budgets andcomparisongeometry. Draft5003only; keep pushing, do notmerge.
