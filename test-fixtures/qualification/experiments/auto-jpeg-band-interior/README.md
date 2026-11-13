# Keep native-band corrections inside sampled feasibility — #5000

The native band guard cleared0011's new absolute B error, but refining to its estimatedsigned-band boundary left the actual G bias at−0.052787, past the unchanged0.05limit. Sampled moments are estimates, not physical acceptance evidence.

First retain the existing global/native/display safety selection and its useful refinement. Then, only if that selected artifact violates a native band check, halve the correction until every safeguard passes. Do not refine back toward the sampled band boundary. Safe existing artifacts remain unchanged. All earlier native RGB, regional/perceptual and display RGB guards remain; every actual physical limit remains mandatory.

An independent synthetic case passes the original safeguards but violates a native bright-band limit. It must keep the first safe half-step rather than approach the band threshold.77Auto tests pass(sixexistingignored). Existing backtracking, zero-residual, exactfootprint, already-correct-channel and localdamage witnesses remain. Full all20physical qualification follows under its own source/hash. Keep all16JPEGs and4separate exactfallbacks,NeutralAgX,versions37/7,sourcebytes,budgets andcomparisongeometry. Draft5003only; keep pushing, do notmerge.

## Completed full checkpoint — goal remains incomplete

Frozen renderer87b1dc14ce:5JPEG passes(0002,0004,0009,0013,0014),11failures,4exactmissing-preview Auto==Neutral fallback passes,0errors. All20RAW hashes,16embedded-reference PNG hashes and the executable hash match. Every checkfamily was compared against cleaned6424ae59: no newly failing display-quality, native absolute or legacy signed-bias checks. Both introduced0011breaches are cleared; signed G bias is now−0.048417 within the original0.05limit.0011still fails its existing other checks. No complete fix is claimed.

Only0011's output PNG changes versus4cf; the other15JPEG images, including allfivepassing controls, are byte-identical. All16original/candidate/reference comparisons were visually inspected across4contact sheets.0015still has flat foreground contrast and0017still looks faded; their failed labels are retained.77Auto tests(sixexistingignored),8realRAW host/cache,7GPU LUT parity,5unchanged-budget banding ramps and the unchanged33Python harness tests pass. All fileheadroom checks pass. The next work addresses remaining image-quality failures; no merge or version bump.
