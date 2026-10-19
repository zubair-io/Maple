# Correct the Auto fit forward operator — #5000

A nonlinear LUT does not commute with footprint averaging. The renderer applies
the LUT to each RAW-derived pixel, quantizes, then the comparator BOX-resizes;
the old point-pair fit instead evaluated the LUT at the footprint mean.
Two equal-mean footprints can require different JPEG outputs. The independent
synthetic witness explicitly builds [0,1] versus [0.5,0.5] footprints, both mean
0.5, with targets0.5 and0.25. The new operator predicts both within0.01.

For each sampled JPEG pixel, construct the actual source footprint using the
canonical pixel-center BOX spans and aspect crop. Average the native-pixel
tetrahedral basis weights BEFORE solving. Each JPEG pixel remains an independent
observation; no brightness-band aggregation occurs. Apply the same operator to
the existing structured LUT for model selection. Input pixels are never mutated.
The fit ignores only sub-code-value quantization; actual PNG gates remain final.

Keep the9-node smooth regularized field and its exactly subdivided33-node artifact.
Use a fixed, deterministically jittered2D sample and hashed holdout rather than
every-Nth-pixel aliasing. Integer sampling uses64-bit modulo before usize casting
so32-bit WASM and64-bit native hosts choose identical coordinates. Holdout
selection requires improved perceptual mean with non-worsening p95 and all three
channels' absolute/squared errors. This is not the acceptance gate.

Independent tests cover equal-mean/different-distribution footprints, identity,
exact coarse-to-fine artifact sampling, orientation, pixel-center BOX spans,
invalid data and integer sampling portability. Physical, visual, host/GPU and
banding qualification remains pending. Neutral AgX, output37/fit7, original
inputs and all fixed harness limits remain unchanged. Keep draft5003 unmerged.

## Complete source5b6d0f1d92 qualification

The complete physical run accounts for20fixtures:2JPEG passes,14failures,4
previewless cases and0errors. All four previewless Auto/Neutral pixel comparisons
pass. All original RAW/preview hashes match.0004 now passes the stronger gate
(mean ΔE4.36618→2.60402);0002 remains passing. This is one newly detected quality
failure cleared, not one of the original12signed-bias failures cleared.

58Auto unit checks pass (6existing ignored),8real-RAW host fit/cache checks,7GPU
LUT parity checks and all5unchanged banding checks pass. Full-frame contact sheets
were inspected across all16JPEG fixtures. However, some already failing images
have NEW regional subcheck failures:006(7),008(5),010(7),011(4),012(6). Overall
case counts hide these regressions. `matched-subchecks.json` preserves them.
0006's pink wall and0012's purple ground are visible regressions despite better
whole-frame means. The whole candidate is NOT accepted as a clean fix.

## Regional selection guard — next change

The fitter now additionally compares held-out perceptual error within every8x8
spatial region. Each must retain at least32validation samples and may increase
by at most0.1ΔE to cover small sampling/quantization drift. This is an added
model-selection restriction; NONE of the acceptance limits are changed. A new
independent witness improves global error while damaging one region and must
be rejected. Eight focused checks pass. The new guard still needs physical
replay and visual review; do not carry source5b6counts forward as its result.
