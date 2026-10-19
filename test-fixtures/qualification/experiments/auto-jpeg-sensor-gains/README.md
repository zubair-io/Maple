# OpcodeList2 sensor gain-map repair experiment — #5000

Audit covers all 20 fixtures: only test_0015 carries OpcodeList2 gain maps (four CFA-site maps, maximum gain 4.68288). These sensor corrections are distinct from the deliberately unused ProfileGainTableMap vendor look. Prior decode read OpcodeList3 only; rawler does not apply OpcodeList2.

Initial implementation parses the sensor gain maps into decoded metadata and applies them after black normalization, before CFA demosaic, retaining unbounded values after the gain. Region/tile calls use absolute sensor coordinates. Linear RGB applies each map plane after linearization. All bindings share this Rust decode prefix; no new GPU display operation or artifact format. Neutral AgX transform, output version 37, fit version 7, original inputs, and quality limits remain unchanged.

This is an unqualified processing experiment. Physical Auto/JPEG comparison, full-corpus regression, native/sized/tile/host parity, and sensor-relative highlight reconstruction with spatially varying gains must be checked before accepting it. The prior complete qualified checkpoint is renderer ed6424ae59: 3 JPEG passes / 13 failures / 4 exact fallback passes. Do not infer a new passing fixture count from unit tests.
