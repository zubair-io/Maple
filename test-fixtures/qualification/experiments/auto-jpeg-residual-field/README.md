# Calibration residual experiment — #5000

Fit a smooth paired-pixel correction to the existing structured camera LUT instead of rebuilding its entire mapping on a coarse grid. Native held-out checks and every display-region safeguard remain unchanged. Selection evaluates the actual final 33-cube nodes after projection, using native-footprint weights at artifact resolution.

The cached probe is unprojected diagnostic evidence only: it is not a physical render, a passing test, or full qualification. test_0004 improves in all sampled display regions; test_0009 improves global errors but has a region exceeding the unchanged local selector allowance and must not be claimed accepted from this probe. Real RAW qualification follows.

## Physical checkpoint

Source `ed6424ae59`: complete 20-fixture run, 3 JPEG passes (0002, 0004, 0014), 13 failures, 4 exact Auto==Neutral fallback passes, zero errors. No new strong-quality subcheck failures against the original images. The original twelve legacy-bias failures are now eleven: 0014 clears. 0004 also clears the new strong-quality baseline. 0003 removes sixteen subcheck breaches but remains failing. All other failed renders remain byte-identical to the original baseline.

64 Auto unit checks pass (6 existing ignored), 33 harness tests pass, 8 real-RAW host/cache checks pass, 7 GPU LUT parity checks pass, and all 5 unchanged-budget banding ramps pass. All 16 three-way contact sheets inspected: no observed new local damage; remaining visible gaps are real failures, especially 0005/0015/0017. Gallery at external `auto-jpeg-residual-field/gallery/index.html`. This is incremental progress, not complete color qualification.

The cached 17-cube capacity probe is diagnostic only; even that finer fit leaves large tails in 0015/0017. Metadata/code inspection identifies missing OpcodeList2 gain-map application as a concrete next sensor-processing lead for 0015; it does not establish that this explains all failures.
