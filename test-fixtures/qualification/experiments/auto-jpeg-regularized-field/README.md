# Mean-input regularized field pilot — #5000

Five physical fixtures were checked: 0005,0015,0017,0002,0014. Only the original passing control0002 passes. No case clears.55 Auto unit checks pass with six existing ignored.0005 mean perceptual error improves from3.86689 to3.21037, but its tail error increases and the full gate still fails.0015/0017 retain the original artifact because selection rejects the candidate. No visual or full-suite success is claimed.

This exposes the remaining forward-model issue: fitting against LUT(mean(RAW footprint)) does not represent mean(LUT(each RAW pixel)), which is what the rendered JPEG comparison measures.

The next source change constructs a separate observation for each sampled JPEG pixel, summing the native-pixel tetrahedral interpolation weights inside its exact BOX footprint BEFORE solving. No brightness-band aggregation is used. RGB, absolute and perceptual/tail selection also use this actual render-order operator. A deterministic jittered two-dimensional sample and hashed holdout avoid aliases from sampling/holding out every Nth pixel. Original inputs and all fixed budgets stay unchanged; output37/fit7 and Neutral AgX stay unchanged. The replacement still requires physical, visual, host/GPU and banding qualification.
