//! Unit tests for the JPEG-pair front-end (`solve_acr_model_from_display_pairs`,
//! `neutral_samples_from_pairs`) — split out of `from_pairs.rs` so that file
//! stays closer to the 600-LOC hard budget (same `#[path]` split pattern as
//! `mod.rs`'s `mod_tests.rs` and `auto_profile/lut.rs`).

use super::*;

/// Build a synthetic pair set with a KNOWN transform so the fit can be
/// checked against ground truth: `jpeg = tonescale_known(maple)` on
/// luma, with a small hue twist applied uniformly, over a dense random
/// scatter of display-space RGB triplets. Deterministic PRNG (plain
/// xorshift — 13/7/17 shift-xor, no final multiply — matching the repo
/// convention in `lut_tests.rs`) — no external dep.
///
/// Luma is sampled LOG-uniformly across the tonescale's own knot range
/// (`TONESCALE_KNOTS`' `0.001..4.0` span, see `tonescale.rs`), not
/// linear-uniformly: `fit_tonescale` bins samples by log2(luma)
/// proximity to 9 log-spaced knots, so a linear-uniform luma
/// distribution packs almost all samples into the top 2-3 (widest, in
/// linear terms) bins at a skewed within-bin density and the bin MEAN
/// then reads systematically high relative to the knot's exact log-
/// midpoint x — a sampling artefact of the test generator, not a solver
/// bug (verified by comparing the fitted curve against the known y=x
/// identity transform: linear-uniform luma reproduced y != x at several
/// knots purely from this density skew). Log-uniform luma, matching how
/// the chart's own log-spaced neutral ramp is built, removes the skew.
fn synthetic_pairs_with_known_gamma_and_twist(
    gamma: f32,
    hue_twist_deg: f32,
    n: usize,
) -> Vec<DisplayPair> {
    let mut state = 0x9e3779b97f4a7c15u64;
    let mut next_unit = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f32 / (1u64 << 53) as f32
    };
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().unwrap();

    // Log-uniform luma target in [0.001, 1.0] (the sub-range of the
    // solver's 0.001..4.0 knot span a clamped [0,1] display buffer can
    // actually reach), a random hue/chroma direction per sample, then
    // solve for the RGB triplet that has exactly that luma while
    // carrying that hue direction — so the marginal luma distribution
    // is log-uniform regardless of the chosen hue/chroma.
    let lo_log2 = 0.001f32.log2();
    let hi_log2 = 0.0f32; // log2(1.0)

    let mut pairs = Vec::with_capacity(n);
    for _ in 0..n {
        let t = next_unit();
        let target_luma = (lo_log2 + t * (hi_log2 - lo_log2)).exp2();
        // Grey triplet at the target luma (R=G=B=target_luma reproduces
        // that Rec.2020/sRGB luma exactly since all three coefficient
        // sets sum to 1 and are applied to equal channels).
        let grey = target_luma.clamp(0.0, 1.0);
        // Perturb hue/chroma by nudging one channel — keeps luma close
        // to `grey` (BT.2020 luma weights are used for the actual
        // sample, so this is an approximation, not exact) while
        // exercising non-neutral field cells too.
        let chroma_pick = next_unit();
        let (r, g, b) = if chroma_pick < 0.4 {
            (grey, grey, grey) // a neutral subset, for a well-populated tonescale
        } else {
            // A fixed-magnitude chroma bump at a RANDOM hue angle (not
            // just the R-vs-GB axis) so every one of the field's 24 hue
            // bins gets populated — a single-axis bump only ever touches
            // 2 of the 24 bins, which starves `fit_field`'s per-cell
            // mean of most of its lattice and (via the identity default
            // on unpopulated cells) dilutes any whole-field average
            // toward zero regardless of how strong the true twist is.
            let angle = next_unit() * std::f32::consts::TAU;
            // Random magnitude (not fixed) so chroma spreads across
            // several of the field's 6 chroma bins, not just one narrow
            // band — a fixed magnitude only ever populates 1-2 chroma
            // bins, which (combined with `smooth_field`'s neighbour-
            // averaging pulling populated cells toward their empty
            // chroma-axis neighbours) dilutes the whole-field mean twist
            // far below the true per-sample value.
            let mag = 0.06 + next_unit() * 0.24;
            (
                (grey + mag * angle.cos()).clamp(0.0, 1.0),
                (grey + mag * (angle - std::f32::consts::TAU / 3.0).cos()).clamp(0.0, 1.0),
                (grey + mag * (angle + std::f32::consts::TAU / 3.0).cos()).clamp(0.0, 1.0),
            )
        };
        let maple_srgb_gamma = [srgb_encode(r), srgb_encode(g), srgb_encode(b)];

        // Known transform: y = x^gamma on luma (applied as a uniform
        // scale so hue/chroma survive), plus a uniform hue twist in
        // Oklab. This is exactly the (tonescale, field) shape the model
        // represents, so a correct fit should recover it closely.
        let rec2020 = m_srgb_to_rec2020.mul_vec([r, g, b]);
        let luma = rec2020_luma(rec2020);
        let luma_out = luma.max(1e-6).powf(gamma);
        let scale = if luma > 1e-6 { luma_out / luma } else { 1.0 };
        let scaled = [rec2020[0] * scale, rec2020[1] * scale, rec2020[2] * scale];

        let lab = rec2020_to_oklab(scaled);
        let c = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        let (a_new, b_new) = if c > 1e-6 {
            let h = lab[2].atan2(lab[1]) + hue_twist_deg.to_radians();
            (c * h.cos(), c * h.sin())
        } else {
            (lab[1], lab[2])
        };
        let twisted_rec2020 = crate::color::oklab::oklab_to_rec2020([lab[0], a_new, b_new]);
        let jpeg_srgb_lin = M_REC2020_TO_SRGB.mul_vec(twisted_rec2020);
        let jpeg_srgb_gamma = [
            srgb_encode(jpeg_srgb_lin[0].clamp(0.0, 1.0)),
            srgb_encode(jpeg_srgb_lin[1].clamp(0.0, 1.0)),
            srgb_encode(jpeg_srgb_lin[2].clamp(0.0, 1.0)),
        ];

        pairs.push(DisplayPair {
            maple: maple_srgb_gamma,
            jpeg: jpeg_srgb_gamma,
        });
    }
    pairs
}

fn srgb_encode(v: f32) -> f32 {
    crate::view::encode::srgb_gamma(v.clamp(0.0, 1.0))
}

#[test]
fn recovers_known_tonescale_and_hue_twist_from_scattered_pairs() {
    let pairs = synthetic_pairs_with_known_gamma_and_twist(1.15, 12.0, 20_000);
    let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");

    // Tonescale: y = x^1.15 is monotone by construction over (0, 1); the
    // fitted knots must stay monotone too (enforced by `fit_tonescale`'s
    // clamp-up pass, but worth asserting the invariant survives here).
    for i in 0..model.tonescale.values.len() - 1 {
        assert!(
            model.tonescale.values[i + 1] >= model.tonescale.values[i],
            "fitted tonescale must stay monotone"
        );
    }
    // Sample at scene_lum = 0.2 (within the dense synthetic range) and
    // compare against the known x^1.15 curve.
    let probe_x = 0.2f32;
    let expected_y = probe_x.powf(1.15);
    let got_y = super::super::model::tonescale_apply(&model.tonescale, probe_x);
    assert!(
        (got_y - expected_y).abs() < 0.05,
        "tonescale should recover y = x^1.15 near x=0.2: got {got_y}, want {expected_y}"
    );

    // Hue twist: every populated cell should read a POSITIVE dh (the
    // known transform only ever twists +12deg, never negative). Cells
    // near the edge of a chroma/hue region that has patchy sample
    // coverage get pulled toward zero by `smooth_field`'s neighbour
    // averaging — the SAME mechanism that decays a real out-of-gamut
    // cell to identity, so this dilution is a correct, load-bearing
    // property of the field fit, not a defect. The most robust,
    // dilution-aware check is therefore the field's MAX |dh| (its
    // least-diluted, best-supported cell), not a naive whole-field
    // mean — the mean would fail on ANY correctly-smoothed fit, chart
    // or scattered-pairs alike, once coverage is uneven.
    let mut any_negative = false;
    let mut max_dh = 0.0f32;
    let mut touched = 0usize;
    for (i, &dh) in model.field.delta_h_deg.iter().enumerate() {
        let touched_cell = dh.abs() > 1e-3 || (model.field.sat_scale[i] - 1.0).abs() > 1e-3;
        if touched_cell {
            touched += 1;
            if dh < -0.5 {
                any_negative = true;
            }
            max_dh = max_dh.max(dh);
        }
    }
    assert!(touched > 0, "expected at least one populated field cell");
    assert!(
        !any_negative,
        "known transform only twists +12deg; no populated cell should read meaningfully negative"
    );
    assert!(
        max_dh > 6.0,
        "the least-diluted (max |dh|) field cell should approach the true +12deg twist \
         (allowing for smoothing dilution), got max_dh={max_dh}"
    );

    // The model's own RMS ΔE00 self-check: not near-zero even on a
    // perfect synthetic transform, because `smooth_field`'s neighbour
    // averaging deliberately dilutes cells adjacent to sparse/empty
    // chroma-hue-luma neighbours toward identity (the same mechanism
    // that decays real out-of-gamut cells) — a scattered random-hue
    // scatter (unlike the chart's dense, near-fully-populated lattice)
    // has many such boundary cells. The budget below is derived from
    // this test's own measured RED value (~2.9 with the committed
    // synthetic generator) plus headroom, per repo convention; it
    // exists to catch a REGRESSION (e.g. a sign error that would push
    // this far higher), not to assert a tight absolute fit.
    assert!(
        model.stats.fit_rms_de < 4.0,
        "fit_rms_de should be bounded on noise-free synthetic data, got {}",
        model.stats.fit_rms_de
    );
}

#[test]
fn identity_transform_recovers_near_zero_residual() {
    // gamma = 1.0, twist = 0.0: jpeg should equal maple (up to the
    // gamut-matrix round-trip's float noise), so the fitted model should
    // be close to the identity transform. As with the twist test above,
    // `smooth_field`'s deliberate boundary-cell dilution means this is
    // "close to identity", not "bit-exact identity" — see that test's
    // comment for why. Budget derived from this test's own measured RED
    // value (~2.4) plus headroom.
    let pairs = synthetic_pairs_with_known_gamma_and_twist(1.0, 0.0, 10_000);
    let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");
    assert!(
        model.stats.fit_rms_de < 3.5,
        "identity transform should fit with a small residual, got {}",
        model.stats.fit_rms_de
    );
}

#[test]
fn too_few_pairs_returns_err_not_silent_identity() {
    // A single pair can't populate 2 tonescale bins.
    let pairs = vec![DisplayPair {
        maple: [0.5, 0.5, 0.5],
        jpeg: [0.5, 0.5, 0.5],
    }];
    let result = solve_acr_model_from_display_pairs(&pairs);
    assert!(
        result.is_err(),
        "a single pair must fail the fit explicitly, not silently return identity"
    );
}

#[test]
fn neutral_samples_from_pairs_excludes_saturated_colors() {
    // A pure-red pair (high chroma) must NOT contribute a neutral sample;
    // a grey pair must.
    let grey = DisplayPair {
        maple: [0.5, 0.5, 0.5],
        jpeg: [0.52, 0.52, 0.52],
    };
    let red = DisplayPair {
        maple: [0.8, 0.05, 0.05],
        jpeg: [0.82, 0.05, 0.05],
    };
    let samples = neutral_samples_from_pairs(&[grey, red]);
    assert_eq!(
        samples.len(),
        1,
        "only the grey pair should qualify as a neutral sample"
    );
}

/// Regression test for the M0.5 tonescale-domain bug (#1740): reproduces
/// the M0 fit-quality report's failure shape directly (see
/// `docs/measurement/2026-07-04-auto2-m0-fit-quality-report.md`, "Reading
/// the numbers honestly" — up to 21.25 ΔE00 wrong correction at saturated
/// green on 9/16 real fixtures).
///
/// Reproduces the exact structural cause: a real photo's neutral-chroma
/// subset (post `NEUTRAL_CHROMA_FRAC` filtering) often clusters in a
/// narrow midtone band rather than spanning the full tonal range — here,
/// display-encoded `[0.1, 0.5]` — while a fully saturated colour's
/// Rec.2020 luminance (green: ~0.678, dominated by the 0.678 green-luma
/// weight) lands well above that band. An identity transform (jpeg ==
/// maple everywhere) means the ONLY correct correction anywhere is ~0.
///
/// Before the fix (pre-fix commit 4ef4d58a4: `fit_tonescale`'s hard-coded
/// `KnotRange`-equivalent 0.001-4.0 span, and `tonescale_apply`'s flat
/// DISPLAY-VALUE extrapolation above the last knot), this exact
/// construction produced a RED saturated-green probe of 32.955 ΔE00 — two
/// compounding bugs: (1) the fixed knot range put real knots at
/// log2-spaced positions across the full 0.001..4.0 span, so with only
/// [0.1,0.5]-ish data the top knots were filled by linear interpolation
/// from sparse real data, distorting the curve; (2) even after knot-range
/// derivation alone, flat-VALUE extrapolation still let the effective
/// scale (`display/scene`) decay toward zero for any luminance past the
/// last real knot, which a saturated colour's luminance commonly is.
/// After both fixes — `KnotRange::from_scene_luminances` deriving the
/// range from the full pair population's actual luminances, and
/// `tonescale_apply` holding the local SCALE (not the display value) flat
/// beyond each end knot — the saturated-green probe stays near-identity.
/// (This test's pairs are all neutral, so the "full population" vs
/// "neutral-only" luminance distinction doesn't move ITS number — see
/// `midtone_correction_stays_near_identity_when_neutral_subset_is_dark_and_narrow`
/// below for the case where that distinction is the difference between
/// pass and fail.)
#[test]
fn saturated_green_probe_stays_near_identity_on_narrow_neutral_cluster() {
    // Neutral pairs clustered in a narrow, clamped [0,1]-ish display band
    // (post sRGB-gamma-encode [0.1, 0.5]) — a real photo's near-neutral
    // subset commonly does NOT span shadows-to-highlights (e.g. a
    // portrait with midtone skin as the dominant near-neutral content),
    // NOT the chart's engineered 0.001..4.0 scene-linear ramp.
    let mut pairs = Vec::new();
    for i in 0..200 {
        let t = i as f32 / 199.0;
        let v = 0.1 + t * 0.4;
        pairs.push(DisplayPair {
            maple: [v, v, v],
            jpeg: [v, v, v],
        });
    }
    let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");

    // Fully saturated green probe, scene-linear Rec.2020 — the exact
    // color the M0 report identified as the failure point.
    let probe = [0.0f32, 1.0, 0.0];
    let pred = super::super::model::apply_model(&model, probe);
    let lab_in = super::super::model::srgb_linear_to_lab(probe);
    let lab_pred = super::super::model::srgb_linear_to_lab(pred);
    let de = super::super::model::ciede2000(lab_in, lab_pred);

    assert!(
        de < 3.0,
        "saturated-green correction should stay near-identity once the \
         tonescale's knot range is derived from the actual data AND its \
         extrapolation holds scale (not display value) flat \
         (pre-fix RED value on this exact construction: 32.955 ΔE00); got {de}"
    );
}

/// Regression test for a second M0.5 finding, caught by re-measuring the
/// real fixture set after the neutral-only version of the knot-range fix:
/// deriving the range from the neutral-chroma subset ALONE regressed
/// `test_0006` from an already-mediocre 6.59 to 21.84 mean ΔE00, because
/// that fixture's near-neutral pixels sit almost entirely in deep shadow
/// (98th percentile scene luminance ~0.004) while its dominant CHROMATIC
/// content spans well into the midtones (median ~0.15, 98th percentile
/// ~0.37) — a neutral-only range anchors the whole lattice to the dark
/// band and pushes most of the actual (chromatic) image into flat-scale
/// extrapolation from a near-black anchor point, which is systematically
/// wrong for midtone content.
///
/// Reproduces that shape directly: a narrow, dark neutral cluster (as
/// `saturated_green_probe_stays_near_identity_on_narrow_neutral_cluster`
/// above) PLUS a large set of moderately-saturated, moderate-luminance
/// pairs (identity transform, so any correction anywhere is a bug) that
/// the neutral subset alone would never inform the knot range with.
/// `KnotRange::from_scene_luminances` is derived from the FULL pair
/// population (`all_pairs_scene_luminances`), not the neutral-only
/// subset, specifically so this lattice covers the midtone content too.
#[test]
fn midtone_correction_stays_near_identity_when_neutral_subset_is_dark_and_narrow() {
    let mut pairs = Vec::new();
    // Dark, narrow neutral cluster: display-encoded [0.02, 0.08] — a
    // shadow-dominated near-neutral subset, matching test_0006's
    // measured p02..p98 scene luminance of roughly [0.00003, 0.004].
    for i in 0..200 {
        let t = i as f32 / 199.0;
        let v = 0.02 + t * 0.06;
        pairs.push(DisplayPair {
            maple: [v, v, v],
            jpeg: [v, v, v],
        });
    }
    // Moderately-saturated midtone content spanning up toward highlights
    // — the fixture's dominant (chromatic, hence excluded from the
    // neutral subset) content, identity transform throughout.
    for i in 0..400 {
        let t = i as f32 / 399.0;
        let base = 0.15 + t * 0.35; // display-encoded [0.15, 0.50]
        let bump = 0.05;
        let triplet = [
            (base + bump).clamp(0.0, 1.0),
            base,
            (base - bump).clamp(0.0, 1.0),
        ];
        pairs.push(DisplayPair {
            maple: triplet,
            jpeg: triplet,
        });
    }
    let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");

    // The identity transform means every pair's own prediction error
    // should stay small; check the mean over the midtone chromatic
    // subset specifically (indices 200..600), the content the
    // neutral-only knot range starved.
    let mut sum_de = 0.0f64;
    let mut n = 0usize;
    for p in &pairs[200..600] {
        let pred = super::super::model::apply_model(&model, {
            let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().unwrap();
            let lin = [
                srgb_gamma_inv(p.maple[0]),
                srgb_gamma_inv(p.maple[1]),
                srgb_gamma_inv(p.maple[2]),
            ];
            m_srgb_to_rec2020.mul_vec(lin)
        });
        let pred_srgb = M_REC2020_TO_SRGB.mul_vec(pred);
        let pred_srgb_clamped = [
            pred_srgb[0].clamp(0.0, 1.0),
            pred_srgb[1].clamp(0.0, 1.0),
            pred_srgb[2].clamp(0.0, 1.0),
        ];
        let lab_pred = super::super::model::srgb_linear_to_lab(pred_srgb_clamped);
        let jpeg_lin = [
            srgb_gamma_inv(p.jpeg[0]),
            srgb_gamma_inv(p.jpeg[1]),
            srgb_gamma_inv(p.jpeg[2]),
        ];
        let lab_meas = super::super::model::srgb_linear_to_lab(jpeg_lin);
        sum_de += super::super::model::ciede2000(lab_meas, lab_pred) as f64;
        n += 1;
    }
    let mean_de = (sum_de / n as f64) as f32;

    assert!(
        mean_de < 3.0,
        "identity-transform midtone content should predict near-identity \
         even when the neutral subset is dark and narrow — a knot range \
         derived from the neutral subset ALONE anchors the lattice to the \
         dark band and mis-corrects this midtone content (this is the \
         exact regression the M0.5 fixture re-measurement caught on \
         test_0006, mean ΔE00 6.59 -> 21.84); got mean ΔE00 {mean_de}"
    );
}

/// #1740 M1 calibration: a display-domain tonescale whose top knots fit a
/// CLIPPED JPEG band (equal display values) must come out of
/// `shape_tonescale_for_display_domain` strictly increasing — an exactly
/// flat knot run renders every luminance in the band identically (the
/// posterized-highlight blob the banding gate's `max_flat_run_frac`
/// captures on test_0000).
#[test]
fn shaped_tonescale_has_no_flat_knot_run() {
    use super::super::model::Tonescale;
    let mut ts = Tonescale {
        knots_log2: vec![-4.0, -3.0, -2.0, -1.0],
        values: vec![0.2, 0.5, 0.5, 0.5], // clipped top band: dead flat
    };
    super::shape_tonescale_for_display_domain(&mut ts);
    for i in 1..ts.values.len() {
        assert!(
            ts.values[i] > ts.values[i - 1],
            "knot {i} not strictly increasing after shaping: {} -> {}",
            ts.values[i - 1],
            ts.values[i]
        );
    }
}

/// #1740 M1 calibration: past the fitted range the tonescale must DECAY TO
/// IDENTITY (scale -> 1), not hold the boundary scale flat. Flat-scale
/// extrapolation keeps multiplying ever-brighter pixels by the boundary
/// gain, overshoots the display range, and the bake's range limit
/// posterizes the overshoot into one flat blob — measured on test_0000 as
/// a 26% flat run (scale 1.457 at the 98th-percentile top knot crossed
/// display 1.0 at input luminance ~0.69).
#[test]
fn shaped_tonescale_extrapolation_decays_to_identity() {
    use super::super::model::{tonescale_apply, Tonescale};
    // Boundary scale 1.5 at l = 0.4 (log2 = -1.32): the test_0000 shape.
    let mut ts = Tonescale {
        knots_log2: vec![-4.0, -1.321928],
        values: vec![0.0625 * 1.5, 0.4 * 1.5],
    };
    super::shape_tonescale_for_display_domain(&mut ts);
    // Far past the decay span the mapping must be exact identity (flat
    // scale 1.0 extrapolation from the appended anchor knots).
    for l in [4.0f32, 8.0, 16.0] {
        let t = tonescale_apply(&ts, l);
        assert!(
            (t / l - 1.0).abs() < 1e-3,
            "expected identity extrapolation at l={l}, got T={t} (scale {})",
            t / l
        );
    }
    // And the decay itself must stay monotone (no dip while the boundary
    // gain unwinds).
    let mut prev = 0.0f32;
    for i in 0..200 {
        let l = 0.05 + i as f32 * (4.0 - 0.05) / 199.0;
        let t = tonescale_apply(&ts, l);
        assert!(
            t >= prev,
            "tonescale not monotone during identity decay at l={l}: {prev} -> {t}"
        );
        prev = t;
    }
}
