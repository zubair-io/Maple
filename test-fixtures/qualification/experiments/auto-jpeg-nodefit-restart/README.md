# REJECTED: Auto JPEG band calibration

Owner review of the before/after gallery found severe visual regressions, including crushed shadows, posterization and color shifts. The signed-band gate passed these defective outputs. The prior completion claim is withdrawn. The calibration has been removed from the render path; its commits and all original receipts remain available.

Every JPEG-bearing fixture must be re-evaluated, including the four original passing controls. No-preview cases require separate fallback checks. Do not select only the three most obvious regressions.

The historical numerical report below is preserved to explain the false positive; it is not accepted image-quality qualification.

---

# Auto embedded-JPEG qualification — #5000

All 12 original failures are cleared. The complete 20-fixture set now has **16 passing JPEG comparisons, 0 failures, 4 unchanged missing previews, and 0 errors**. Missing previews are not passes. The four original passing controls remain passing.

The previous structured model already missed the target before LUT baking. Fit the actual baked tetrahedral LUT using the reference-luma band means, correct BOX sampling geometry, smooth bounded updates, and monotone projections. When structured initialization stalls, restart from a separable monotone prior using the same tetrahedral design rows. Retain the best measured candidate. No per-camera rules or extra apply-time stage are added.

Final processing commit: `62afc78711e1c7e696611bde057c2d79a2753a24`.
Binary SHA-256: `65bb5ba6365080c5e21e16905146eb5fcf52c073e4fec09d269ed72b682cf9f5`.
The full result is `../../color-suite-5000-auto-embedded-jpeg-final.json`; the two disjoint final shards are `leica-point-result.json` and `final-rest-result.json`.

Every original RAW hash and all 16 embedded-JPEG reference hashes match the baseline. All candidate hashes were checked and all comparisons independently recomputed with the final comparator. Four no-preview sentinels were reconfirmed. No original inputs or budgets changed.

Leica test_0017 is close to the unchanged 0.05 limit: worst absolute channel-band bias 0.04982592376884747. Repeating with four Rayon workers instead of two produces the identical candidate PNG hash and metrics (`leica-workers4-result.json`). This is corpus qualification, not a claim of pixelwise equivalence or coverage of every camera.

## Final validation

- Auto unit tests: 57 pass, 6 pre-existing ignored.
- Real-RAW host fit/cache tests: 8 pass.
- GPU LUT parity: 7 pass at existing thresholds.
- Existing Auto2 banding checks: all 5 pass at unchanged budgets.
- Canonical entrypoint contracts: 4 pass; JPEG runner contracts: 9 pass.
- Code generation completed with no generated diff.

Neutral AgX, pipeline output version 37, and Auto fit version 7 remain unchanged. ACR image comparisons were removed from active CI/color tests per the owner request; preserved historical ACR results are not the current target. Work stays on draft #5003; nothing is merged.
