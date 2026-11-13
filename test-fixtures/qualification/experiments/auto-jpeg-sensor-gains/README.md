# OpcodeList2 sensor gain-map repair experiment — #5000

Audit covers all 20 fixtures: only test_0015 carries OpcodeList2 gain maps (four CFA-site maps, maximum gain 4.68288). These sensor corrections are distinct from the deliberately unused ProfileGainTableMap vendor look. Prior decode read OpcodeList3 only; rawler does not apply OpcodeList2.

Initial implementation parses the sensor gain maps into decoded metadata and applies them after black normalization, before CFA demosaic, retaining unbounded values after the gain. Region/tile calls use absolute sensor coordinates. Linear RGB applies each map plane after linearization. All bindings share this Rust decode prefix; no new GPU display operation or artifact format. Neutral AgX transform, output version 37, fit version 7, original inputs, and quality limits remain unchanged.

This is an unqualified processing experiment. Physical Auto/JPEG comparison, full-corpus regression, native/sized/tile/host parity, and sensor-relative highlight reconstruction with spatially varying gains must be checked before accepting it. The prior complete physical checkpoint is renderer ed6424ae59: 3 JPEG passes / 13 failures / 4 exact fallback passes. Do not infer a new passing fixture count from unit tests.

## Physical pilot outcome

Source a9096cd9a0: 0015 remains failing; the three passing control renders (0002/0004/0014) are byte-identical to ed6424ae59. The four-case pilot is NOT a new full-corpus result. Its mean display ΔE improves 9.31686 → 8.73163 and p95 22.66948 → 21.19431, but R MAE worsens 0.09327 → 0.11106, some regional checks newly fail, and visible contrast mismatch remains. The photo shows the false dark corners removed, but this candidate is not accepted as a finished color fix. Preserve the failed result and repair the remaining processing/fitting faults.

64 Auto unit tests pass (6 existing ignored); 8 real Pixel 6 Pro RAW host/cache tests pass. New sensor-map tests: 3 passes; existing linearization: 11 passes; opcode parser/application: 36 passes. Those tests establish implementation and parity, not image-quality acceptance. The cached 17-cube probe remains diagnostic and also retains a large p95 error; increasing LUT resolution alone is not a demonstrated solution.
