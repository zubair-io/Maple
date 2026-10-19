# Calibration residual experiment — #5000

Fit a smooth paired-pixel correction to the existing structured camera LUT instead of rebuilding its entire mapping on a coarse grid. Native held-out checks and every display-region safeguard remain unchanged. Selection evaluates the actual final 33-cube nodes after projection, using native-footprint weights at artifact resolution.

The cached probe is unprojected diagnostic evidence only: it is not a physical render, a passing test, or full qualification. test_0004 improves in all sampled display regions; test_0009 improves global errors but has a region exceeding the unchanged local selector allowance and must not be claimed accepted from this probe. Real RAW qualification follows.
