# Independent NLM center-weight-floor witness

On exact production37 source95fc03d6819b34f46f928ba93de58188a4014022, the added analytic test fails: expected1/9=0.11111111 but got0.90800714 for eight equal neighbor distances at exponent32. Equal Gaussian weights, including a maximum-neighbor center weight, must cancel their absolute magnitude through normalization. CPU general/tiled and GPU paths instead clamp the center weight to1e-12. Existing numerical error bound5e-6 is unchanged.

No implementation adopted yet. A stable relative-weight reduction should be evaluated to preserve normalized Gaussian ratios without absolute-weight underflow; simply replacing a floor with another cutoff would leave that numerical issue. First validate the new and existing CPU/GPU tests, then physical controls and all20 Auto cases. No pipeline version bump. The zero-test exact-name observation was retained; the second receipt actually runs and fails one test.
