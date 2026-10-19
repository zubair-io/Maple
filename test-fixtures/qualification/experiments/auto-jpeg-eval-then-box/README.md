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
