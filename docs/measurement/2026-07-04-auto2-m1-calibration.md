# Auto 2.0 M1 calibration round — #1740

Companion to the M0/M0.5 fit-quality report
(`2026-07-04-auto2-m0-fit-quality-report.md`). This note records the M1
calibration of the structured fit (`acr_fit::from_pairs`) against the two
M1 instruments: the ACR-parity harness's `baseline_auto` table
(`MAPLE_AUTO2=1 FILTER=baseline src/scripts/test_color_pipeline.sh`) and
the Auto Profile tail section of the banding gate
(`src/scripts/test_banding.sh`, the `maple-cli auto-tail-ramp`
instrument added in this round). Per the "no eyeballing" contract, every
number below is a harness output; no visual judgments appear anywhere in
this round.

## The RED starting point (2026-07-04, main @ f39fe2eaa)

Banding gate, Auto Profile tail keys, `MAPLE_AUTO2=1` on `test_0000`
(ceilings are the Auto 1.0-derived ones — "hold or improve on the
shipping tail"):

```
test_0000_auto2_neutral/18_auto_tail/luma
    max_flat_run_frac: 0.260997 > budget ceiling 0.02
test_0000_auto2_foliage/18_auto_tail/chroma
    max_abs_d2: 0.00123631 > 0.001
    max_spike_ratio: 1.63862 > 1.2
```

The neutral flat run is the operator's posterized-highlight repro,
captured quantitatively: every neutral input above linear luminance
≈ 0.739 rendered as output luma exactly 1.0 — 26% of the tonal range
collapsed onto one value. Mechanism (traced via the fitted model dump):
the knot range's 98th-percentile ceiling put `test_0000`'s highlight
population past the last knot (l_top = 0.4155, boundary scale 1.457);
flat-SCALE extrapolation kept multiplying brighter pixels by 1.457 until
the prediction crossed display 1.0 at l ≈ 0.686, where the bake's hard
`clamp(0.0, 1.0)` flattened everything above it.

ACR-parity harness (`MAPLE_AUTO2=1 FILTER=baseline`): **11 breaches**
(test_0002/0004/0005/0006/0007/0009/0010/0011/0012/0013/0017), grand
`baseline_auto` mean ΔE00 **8.06** vs Auto 1.0's **7.55** on the same
day/machine (default-mode run of the same commit; Auto 1.0 itself carries
1 pre-existing breach — test_0010 `max 33.14 > 30.50`).

## Calibration levers

| #   | Lever                            | Final setting                                                                                                                                                                                                                                                    | File                                                           |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Tonescale knot percentile bounds | kept 2nd/98th — the 99.9th ceiling was tried and REJECTED (see log: it fixed highlights by starving midtones)                                                                                                                                                    | `acr_fit/tonescale.rs`                                         |
| 2   | Tonescale minimum slope          | strict monotonicity, ≥ 5% of the linear luminance gap per knot (kills clipped-band flat knots)                                                                                                                                                                   | `acr_fit/from_pairs.rs` (`shape_tonescale_for_display_domain`) |
| 3   | Identity-decay extrapolation     | 3 appended knots decay the boundary scale to exactly 1.0 over `max(1.5, 2.2·(scale−1))` stops (smoothstep)                                                                                                                                                       | `acr_fit/from_pairs.rs`                                        |
| 4   | Bake range limit                 | hard `clamp(0,1)` → C¹ Reinhard shoulder, knee 0.95 (same constant as `compress_input`); knee 0.98 tried first, left the asymptote slope under the flat-run epsilon (0.0254 residual flat run)                                                                   | `acr_fit/bake.rs` (`shoulder_01`)                              |
| 5   | Field sample weighting           | per-sample chroma-ratio bound [0.25, 4.0] (an unshrunk test_0000 cell mean was 33.8×)                                                                                                                                                                            | `acr_fit/field.rs`                                             |
| 6   | Field count shrinkage            | cell mean × `count/(count+8)` toward identity — pairs front-end only; the chart solver passes `shrink_k = 0` (its ~1-patch-per-cell density is a design constant, not a confidence signal; K=8 there regressed the 6°-twist capture test to −4.3° mean residual) | `acr_fit/field.rs` (`PAIRS_SHRINK_K`)                          |
| 7   | Neutral-subset chroma threshold  | `NEUTRAL_CHROMA_FRAC` 0.10 → 0.15 (admits lightly-tinted midtone near-neutrals; fixes the M0.5-class "neutrals cluster in one luma band" starvation)                                                                                                             | `acr_fit/from_pairs.rs`                                        |

## Calibration log

Banding column = the ten `test_0000_auto{1,2}_*/18_auto_tail/*` keys.
Breaches/grand = `MAPLE_AUTO2=1 FILTER=baseline` `baseline_auto` table
(20 cases; 16 usable fixtures + 4 no-preview passthroughs).

| iter      | levers                                                         | banding tail keys                                                   | breaches                                                      | grand auto ΔE00 |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| 0 (main)  | —                                                              | RED: neutral flat 0.261, foliage d2 0.00124 / ratio 1.64            | 11                                                            | 8.06            |
| 1a        | 2+3+5+6 + hi-pct 99.9 + shoulder knee 0.98                     | neutral flat 0.0254 (RED), foliage GREEN (d2 0.000022, ratio 0.094) | — (banding still red; not measured)                           | —               |
| 1b        | 1a with shoulder knee 0.95                                     | ALL GREEN (neutral flat 0.000, d2 0.000872)                         | 9 (0002 0005 0006 0007 0009 0010 0012 0013 0017)              | 7.91            |
| bisect C  | 1b with hi-pct back to 98th, `FILTER=test_0006`                | —                                                                   | test_0006 mean 6.43 → 4.40 (the 99.9th pct was the regressor) | —               |
| bisect N  | C + `NEUTRAL_CHROMA_FRAC` 0.15, `FILTER=test_0006`/`test_0007` | —                                                                   | test_0006 4.40 → 3.75; test_0007 1.75 → 1.85                  | —               |
| 2 (final) | 2+3+4(knee 0.95)+5+6+7, hi-pct 98th                            | ALL GREEN (`test_banding.sh` exit 0, all 20 keys)                   | 10 (0002 0005 0006 0007 0009 0010 0011 0012 0013 0017)        | 7.68            |

## Final ship-gate table

Auto 1.0 column = the default-mode run of the same day/machine (main
@ f39fe2eaa numbers — this branch's default mode is digit-for-digit
identical, see the PR's gates section). Auto 2.0 column = the final
calibrated `MAPLE_AUTO2=1` run. Mean ΔE00 vs the ACR reference,
`baseline_auto` budget verdict alongside. test_0001/0018/0019/0020 carry
no usable embedded preview — the Auto fit no-ops and both columns are
identical — so the usable set is 16 fixtures.

| fixture   | Auto 1.0 mean | Auto 2.0 mean |     Δ | Auto 2.0 verdict                                        |
| --------- | ------------: | ------------: | ----: | ------------------------------------------------------- |
| test_0000 |          3.37 |          3.14 | −0.23 | PASS (improves)                                         |
| test_0002 |          2.78 |          3.43 | +0.65 | FAIL mean 3.43>3.00                                     |
| test_0003 |          3.23 |          2.93 | −0.30 | PASS (improves)                                         |
| test_0004 |          6.46 |          5.34 | −1.12 | PASS (improves)                                         |
| test_0005 |          6.15 |          5.15 | −1.00 | FAIL max 91.64>81.90 (mean improves)                    |
| test_0006 |          1.57 |          3.75 | +2.18 | FAIL mean/p95/bias_B                                    |
| test_0007 |          1.09 |          1.85 | +0.76 | FAIL mean/p95/bias_R/bias_G                             |
| test_0008 |          7.80 |          6.99 | −0.81 | PASS (improves)                                         |
| test_0009 |          6.49 |          6.97 | +0.48 | FAIL mean/p95/max                                       |
| test_0010 |          8.57 |          8.64 | +0.07 | FAIL p95/max (Auto 1.0 also FAILs max 33.14>30.50 here) |
| test_0011 |          4.46 |          4.71 | +0.25 | FAIL mean 4.71>4.62                                     |
| test_0012 |          6.41 |          8.41 | +2.00 | FAIL mean, bias_R +0.0889                               |
| test_0013 |          5.77 |          5.19 | −0.58 | FAIL p95 12.38>11.70 (mean improves)                    |
| test_0014 |          3.60 |          3.51 | −0.09 | PASS (improves)                                         |
| test_0015 |         11.68 |         11.31 | −0.37 | PASS (improves)                                         |
| test_0017 |         10.00 |         10.72 | +0.72 | FAIL mean/p95/bias_R                                    |

Grand `baseline_auto` mean: Auto 1.0 **7.55**, Auto 2.0 **7.68** (was
8.06 pre-calibration). Mean holds-or-improves vs Auto 1.0 on **9/16**
usable fixtures (8 improve, test_0010 +0.07 ≈ holds); full budget-green
on **6/16** (0000, 0003, 0004, 0008, 0014, 0015).

## Verdict

The M1 ship-gate — `baseline_auto` holds-or-improves on ≥ 15/16 usable
fixtures AND the auto2 banding gate green — is **half-met**: the banding
gate is fully green in both modes (the posterized-highlight defect is
structurally gone and gated against regression), but fidelity reaches
9/16 holds-or-improves after honest iteration across every lever the
M0/M0.5 reports named. Per the epic's fallback this round therefore
recommends: **keep Auto 1.0's fit as the shipping default, keep Auto
2.0's gates and calibrated fit behind `MAPLE_AUTO2`** — do not flip M2
yet.

What resists, and why (the breach classes):

1. **Per-channel/WB casts the structured model cannot express by
   design.** test_0012 (bias_R +0.0889), test_0009/test_0010 (uniform
   +0.06..0.09 warm push), test_0002 (bias_B +0.0324): Auto 1.0's
   per-channel curve shifts color balance; Auto 2.0's tonescale is
   deliberately luminance-preserving and its field only twists hue and
   scales chroma — a global cast has NO lever in the current model.
   This is exactly the component the epic's M3 ("surface the fitted
   tone/WB components as visible, undoable offsets") introduces; fixing
   it as a hidden fit-term now would duplicate that work.
2. **Budgets that encode the free LUT's overfit.** test_0006 (budget
   1.90, best-achieved 3.75) and test_0007 (budget 1.20, best-achieved
   1.85): the M0 report already showed the free 49³ LUT fitting these
   fixtures' JPEGs ~2.5x tighter than the structured model's honest
   ceiling. Their budgets are Auto 1.0's achieved numbers, so a
   bounded, smooth model cannot ratchet under them without growing
   expressiveness (finer field, or the M3 WB term).
3. **Near-misses within noise of the ratchet.** test_0011 (4.71 vs
   4.62), test_0013 (p95 12.38 vs 11.70), test_0017 (10.72 vs 10.60):
   within a few percent; likely to flip with class-1's WB term.
4. **test_0005 max-only** (91.64 vs 81.90, mean improves by a full
   unit): the same outlier region measures 91.86 in the NEUTRAL pass of
   the same commit — a view-transform-domain outlier the free LUT
   happens to mask, not a defect Auto 2.0 introduces.

What the calibration DID buy, measured: the operator's posterized
highlights are gone by construction (flat-run 0.261 → 0.000; second-
difference and spike-ratio now BELOW Auto 1.0's own tail on every
ramp), grand fidelity narrowed 8.06 → 7.68 against Auto 1.0's 7.55, and
Auto 2.0 now beats Auto 1.0 outright on 8 fixtures — including
test_0000, the operator's named highlight-blob repro.
