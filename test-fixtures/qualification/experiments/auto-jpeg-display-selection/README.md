# Match perceptual selection to display scale — #5000

The independent fixed quality gate measures mean/tail CIEDE2000 at1024px display scale. The fitter still used native-preview pixel CIEDE tails globally, even though local perception was already checked at display scale. On aligned fixture0005, a1/16step improves sampled display mean3.84494→3.70971 and p959.97059→9.94821 and retains the0.1 regional selector margin, while native p9512.23613→12.26890 rejected it.

Global and regional perceptual checks now use the same display footprints. Held-out native RGB absolute/squared errors and minimum32native validation samples remain required; every64region still needs32samples and the same0.1DE margin. All independent physical image-quality checks and budgets are unchanged. No image alignment, exposure/color compensation, input mutation, AgX or version changes.

The new synthetic regression independently demonstrates improved display perception despite a worse native detail tail, then proves a perfect native RGB baseline still blocks the candidate. All15 paired tests pass. Physical verification follows; cached probes and unit tests are not passing image qualification.

Physical source79606603d1 pilot: all four aligned failures0005/0006/0007/0010 still fail(0passes,4failures,0errors);66 Auto unit checks pass(6 existing ignored). This pilot is not a full-corpus count and no case is claimed cleared. The prior complete source2ff187bacb remains5pass/11fail/4fallback. Keep the goal active and diagnose remaining fit capacity/processing; never relax the independent gate.
