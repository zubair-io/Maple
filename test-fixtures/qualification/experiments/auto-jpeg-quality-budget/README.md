# Selecting Auto proposals by fixed quality budgets — #5000

Renderer15d26545dd: full20 run **5JPEGpasses/11failures/4exactfallbacks/0errors**. All20RAW,16reference,frozenbinary hashes verified.92Auto units pass(six existingignored),8realRAW host/cache,7GPU LUTparity,5unchanged-budget banding,fileheadroom pass. All16original/current/JPEGtriplets reviewed. No completed-color-suite claim. Keep draft5003; do notmerge. NeutralAgX,output37,fit7,originalbytes,physicalgateandalltolerances unchanged.

## Measured progress

Versus7cfe:74individual checks clear and0newchecks fail. Only0008,0015,0017outputPNG change;other13arebyte-identical.0008clears45display,11nativeabsolute,6signedbiaschecks;0015clears6display+1native;0017clears5display. Versus27f(the start of this goal turn),73netchecks clear and0areadded: the intervening0017tileGregression is repaired. **No new photograph fully passes.** Five positive controls remain passing.

MeanDE:0008 5.7709→4.1600;0015 6.7334→6.4263;0017 9.5405→9.0222. Their already-failing DEp95 increases (0008 19.26→20.08,0015 21.13→21.35,0017 21.44→21.86); every value remains recorded and red.0015stilllacksforegroundcontrast and0017stillfaded.0008visiblycloser toJPEG butstillfails. Remaining failures:0000,0003,0005,0006,0007,0008,0010,0011,0012,0015,0017.

## Selection change

The previous internal Pareto rule could reject a correction with fewer/smaller quality violations because an already-failed tail or squared error increased. Selection now scores native per-luminance-band absolute/signed errors, all64display tile/channel absolute errors, display perceptual mean/p95 andRGBp95 against unchanged0.05/0.1/5/10limits. A larger already-failing DEp95 or squared error is admissible only when the largest scored budget violation strictly decreases. Heldout channel MAEs cannot increase. Passing DEp95 cannot worsen. RGBtail/region,nativeband/signed,samplecoverage protections and LUTprojection constraints remain. Physical clipping/gradient checks remain independent and unchanged; they are not represented by this sampled ranking score. The actual physical suite still decides acceptance.

## Diagnostics and rejected probe

0008selects registered-paired at0.984375.0010selects original-paired at0.654296875; its display gate passes but nativeband1 R0.050524/B0.060260 stillfail.0015selects original-paired at1.0; registeredproposal improves worst normalized nativebudget but worsens already-bad regionalDE and is rejected. All three diagnostic-render PNGs byte-match the full physical run. Full observations are preserved externally and in NAS backup; small identity/selection reports are committed.

A separate weighted per-channel rank-transport contrast/CDF proposal, solved with exact eval-then-BOX operators and unchanged projection, worsens0015meanDE to~7.72 andp95to~24.00. It is **rejected diagnostic evidence**, not production or a passing claim. Do not switch to histogram matching or revive the withdrawn bandmean-calibration.

## Next

Use the actual captured native/display operators to solve constrained/minimax absolute-error objectives against the original fixed group budgets, first testing whether0008/0010remainingnativebands are feasible without harming passingdisplaychecks. This differs from arbitrary reweighting of a global squared loss. Preserve projection/banding and passing safeguards; prototype before new runtime code. Every accepted processing chunk still requires all16JPEGphotographs+4fallbacks,all3checkfamilies,visualreview,hashes,host/GPU/banding and a pushed draft. No comparator registration or renderer framing change; geometry policy remains pending.

Full local gallery: `/Users/riabuz/.codex/color-suite-evidence/5000/auto-jpeg-quality-budget/gallery/index.html`.
