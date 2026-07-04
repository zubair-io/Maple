//! Unit tests for [`super`] (the Oklab HSL color-mixer stage). Split out of
//! `hsl.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;
use crate::color::oklab::rec2020_to_oklab;
use crate::image::{ColorSpace, Image};

const BANDS: usize = NUM_BANDS;

fn zero_bands() -> [f32; NUM_BANDS] {
    [0.0; NUM_BANDS]
}

fn grey_scene(w: u32, h: u32, v: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [v, v, v];
    }
    img
}

// ── Neutral-axis identity ──────────────────────────────────────────────

/// All-default model is a bit-identical no-op (whole-stage gate).
#[test]
fn all_defaults_is_bit_identical() {
    let mut img = grey_scene(8, 8, 0.18);
    let before = img.pixels.clone();
    apply(&mut img, &zero_bands(), &zero_bands(), &zero_bands());
    assert_eq!(
        img.pixels, before,
        "all-default model must be bit-identical no-op"
    );
}

/// Any slider set with a neutral (grey) input is a no-op because
/// chroma C = 0 and the gate is exactly zero.
#[test]
fn any_slider_on_neutral_is_identity() {
    // Test all eight SAT sliders at +100 and -100 — most aggressive
    // combination; neutral input must still be unchanged.
    for band in 0..BANDS {
        for &sv in &[-100.0_f32, 100.0] {
            let mut sat = zero_bands();
            sat[band] = sv;
            let mut img = grey_scene(4, 4, 0.18);
            let before = img.pixels.clone();
            apply(&mut img, &zero_bands(), &sat, &zero_bands());
            for (i, (a, b)) in img.pixels.iter().zip(before.iter()).enumerate() {
                assert!(
                    (a[0] - b[0]).abs() < 1e-5
                        && (a[1] - b[1]).abs() < 1e-5
                        && (a[2] - b[2]).abs() < 1e-5,
                    "sat[{band}]={sv}: neutral pixel {i} changed: {a:?} != {b:?}"
                );
            }
        }
    }

    // Hue sliders — same invariant
    for band in 0..BANDS {
        let mut hue = zero_bands();
        hue[band] = 100.0;
        let mut img = grey_scene(4, 4, 0.18);
        let before = img.pixels.clone();
        apply(&mut img, &hue, &zero_bands(), &zero_bands());
        for (i, (a, b)) in img.pixels.iter().zip(before.iter()).enumerate() {
            assert!(
                (a[0] - b[0]).abs() < 1e-5
                    && (a[1] - b[1]).abs() < 1e-5
                    && (a[2] - b[2]).abs() < 1e-5,
                "hue[{band}]=100: neutral pixel {i} changed: {a:?} != {b:?}"
            );
        }
    }
}

// ── Partition-of-unity ────────────────────────────────────────────────

/// The normalized raised-cosine band weights sum to exactly 1 at every
/// Oklab hue angle with non-zero raw weight. This is the invariant
/// (enforced by the per-pixel normalization in `apply_pixel`) that
/// makes SAT +100 on all bands exactly 2× global saturation, and keeps
/// the stage consistent across hue regardless of non-uniform band spacing.
///
/// Also verifies that no coverage gap exists at any sampled hue
/// (raw weight sum > 0 everywhere with BAND_HALF_WIDTH_DEG = 67.5°).
#[test]
fn partition_of_unity_holds_at_sample_hues() {
    // Sample 72 hue angles evenly
    for i in 0..72u32 {
        let h = (i as f32) * 5.0;
        // Compute raw weights (same as apply_pixel does)
        let mut raw_sum = 0.0f32;
        let mut w = [0.0f32; BANDS];
        for band in 0..BANDS {
            let delta = circular_delta_deg(h, HUE_CENTERS_DEG[band]);
            w[band] = raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
            raw_sum += w[band];
        }
        assert!(
            raw_sum > 1e-6,
            "coverage gap at hue {h}°: raw_sum = {raw_sum} (increase BAND_HALF_WIDTH_DEG)"
        );
        // Normalized weights sum to exactly 1
        let norm_sum: f32 = w.iter().map(|wi| wi / raw_sum).sum();
        assert!(
            (norm_sum - 1.0).abs() < 1e-5,
            "normalized partition-of-unity violated at hue {h}°: sum = {norm_sum}"
        );
    }
}

// ── Closed-form predictor (known-chroma color per band) ───────────────

/// For a color whose Oklab hue angle is at a band center, the SAT
/// slider for that band must scale the Oklab chroma by the expected
/// factor. The predictor accounts for normalization: the weight at
/// band center `w_b = rc(0) / sum_all_rc = 1 / sum_all_rc`. With
/// neighboring bands also contributing, the effective chroma scale is
/// `1 + (sat_scale[b] - 1) · w_b`. Other bands are at their default
/// sat_scale=1 → their contribution to delta_sat_scale is 0.
///
/// Uses `c_in = 0.04` (vs. the pre-#1733 `0.10`) so the +100 case's target
/// chroma stays safely inside the Rec.2020 hull for every band at
/// `L=0.5` — this test's job is to pin the exact-linear-scaling predictor,
/// which only holds below the gamut knee (`hsl_soft_compress` is identity
/// there). The near-hull / out-of-gamut half of the curve is covered
/// separately by `saturation_band_keeps_all_channels_non_negative_near_hull`
/// (#1733 clamp-audit fix — HSL SAT now soft-compresses toward the hull
/// exactly like `saturation::apply_pixel` / `vibrance::apply_pixel`, so it
/// no longer emits negative Rec.2020 channels, but that means an
/// aggressive SAT+100 near the hull is NOT exactly linear anymore).
#[test]
fn saturation_scales_chroma_at_band_center() {
    for band in 0..BANDS {
        let center_rad = HUE_CENTERS_DEG[band].to_radians();
        // Construct a Rec.2020 color at the band's Oklab hue center with a
        // known chroma: above CHROMA_GATE_C0*2 (=0.10) so the chroma gate
        // is exactly 1.0, but low enough that c_in*(1+1.0) stays in-gamut
        // for every band at L=0.5 (checked against the hull below).
        let c_in = 0.04_f32;
        let a0 = c_in * center_rad.cos();
        let b0 = c_in * center_rad.sin();
        let l0 = 0.5_f32;
        let rgb = crate::color::oklab::oklab_to_rec2020([l0, a0, b0]);

        // Compute the normalized weight for this band at its own center.
        let mut raw_sum = 0.0f32;
        for b in 0..BANDS {
            let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
            raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
        }
        let w_band = 1.0_f32 / raw_sum; // rc(0)/raw_sum = 1/raw_sum

        for &sv in &[-50.0_f32, 50.0, 100.0] {
            let mut sat = zero_bands();
            sat[band] = sv;
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, &zero_bands(), &sat, &zero_bands());

            let lab_out = rec2020_to_oklab(img.pixels[0]);
            let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();

            // Only the target band has non-zero delta: (sat_scale[b]-1) * w_band
            let delta_scale = (sv / 100.0) * w_band;
            // chroma_gate at c_in=0.04 vs 2*C0=0.10: exactly 1.0
            let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);
            let effective_delta = delta_scale * chroma_gate;
            let expected_c = (c_in * (1.0 + effective_delta)).max(0.0);
            assert!((c_out - expected_c).abs() < 0.005,
                "band {band} SAT {sv}: c_out={c_out:.4} expected≈{expected_c:.4} (w_band={w_band:.3})");
            // L must not change (luminance slider = 0)
            assert!(
                (lab_out[0] - l0).abs() < 1e-3,
                "band {band} SAT {sv}: L changed from {l0} to {}",
                lab_out[0]
            );
        }
    }
}

/// For a color at a band center, the HUE slider rotates the Oklab
/// hue by `w_band · slider/100 · HSL_HUE_MAX_DEG` degrees, where
/// `w_band = rc(0) / sum_all_rc` is the normalized weight for that band
/// at its own center.
#[test]
fn hue_rotates_at_band_center() {
    for band in 0..BANDS {
        let center_rad = HUE_CENTERS_DEG[band].to_radians();
        let c_in = 0.10_f32; // > 2 * C0 so chroma_gate ≈ 1
        let a0 = c_in * center_rad.cos();
        let b0 = c_in * center_rad.sin();
        let rgb = crate::color::oklab::oklab_to_rec2020([0.5, a0, b0]);

        // Normalized band weight at this band's own center
        let mut raw_sum = 0.0f32;
        for b in 0..BANDS {
            let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
            raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
        }
        let w_band = 1.0_f32 / raw_sum;
        let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);

        for &hv in &[-100.0_f32, -50.0, 50.0, 100.0] {
            let mut hue = zero_bands();
            hue[band] = hv;
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, &hue, &zero_bands(), &zero_bands());

            let lab_out = rec2020_to_oklab(img.pixels[0]);
            let h_out = oklab_hue_deg(lab_out[1], lab_out[2]);
            let h_in_deg = HUE_CENTERS_DEG[band];
            // Effective rotation = hue_rad[band] * w_band * chroma_gate (in degrees)
            let expected_rot = hv / 100.0 * HSL_HUE_MAX_DEG * w_band * chroma_gate;
            let actual_rot = {
                let mut d = h_out - h_in_deg;
                while d > 180.0 {
                    d -= 360.0;
                }
                while d <= -180.0 {
                    d += 360.0;
                }
                d
            };
            assert!((actual_rot - expected_rot).abs() < 3.0,
                "band {band} HUE {hv}: rot={actual_rot:.1}° expected≈{expected_rot:.1}° (w_band={w_band:.3})");
            // Chroma should be unchanged (hue-only rotation)
            let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();
            assert!(
                (c_out - c_in).abs() < 0.005,
                "band {band} HUE {hv}: chroma changed {c_in} → {c_out}"
            );
        }
    }
}

/// For a color at a band center, the LUM slider scales Oklab L by
/// `1 + (slider/100) · w_band · chroma_gate`, where `w_band` is the
/// normalized weight for that band at its own center. Hue is unchanged,
/// and chroma is unchanged **unless** the L shift moves the pixel to a
/// part of the Rec.2020 hull narrower than the input chroma — the hull's
/// radius depends on L, so scaling L (like rotating hue, #1748 review fix)
/// can require the same gamut-hull compression as the SAT/HUE sliders.
/// When that happens chroma may only shrink (never grow) and every
/// channel must stay non-negative; the L target itself is unaffected by
/// the chroma-only compression.
#[test]
fn luminance_scales_l_at_band_center() {
    for band in 0..BANDS {
        let center_rad = HUE_CENTERS_DEG[band].to_radians();
        let c_in = 0.10_f32; // > 2 * C0 → chroma_gate ≈ 1
        let a0 = c_in * center_rad.cos();
        let b0 = c_in * center_rad.sin();
        let l0 = 0.5_f32;
        let rgb = crate::color::oklab::oklab_to_rec2020([l0, a0, b0]);

        // Normalized band weight at this band's own center
        let mut raw_sum = 0.0f32;
        for b in 0..BANDS {
            let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
            raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
        }
        let w_band = 1.0_f32 / raw_sum;
        let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);

        for &lv in &[-50.0_f32, 50.0] {
            let mut lum = zero_bands();
            lum[band] = lv;
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, &zero_bands(), &zero_bands(), &lum);

            let lab_out = rec2020_to_oklab(img.pixels[0]);
            // Effective lum_shift = (lv/100) * w_band * chroma_gate
            let effective_shift = (lv / 100.0) * w_band * chroma_gate;
            let expected_l = l0 * (1.0 + effective_shift);
            assert!(
                (lab_out[0] - expected_l).abs() < 0.01,
                "band {band} LUM {lv}: L={} expected≈{expected_l} (w_band={w_band:.3})",
                lab_out[0]
            );
            // Chroma must not increase beyond the input, and every
            // Rec.2020 channel must stay non-negative (gamut-hull
            // compression may shrink chroma if the shifted L narrows the
            // hull below c_in — see doc comment above).
            let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();
            assert!(
                c_out <= c_in + 0.01,
                "band {band} LUM {lv}: chroma grew {c_in} → {c_out}"
            );
            let min_channel = img.pixels[0]
                .iter()
                .cloned()
                .fold(f32::INFINITY, f32::min);
            assert!(
                min_channel >= -1e-4,
                "band {band} LUM {lv}: output {:?} has negative channel {min_channel}",
                img.pixels[0]
            );
        }
    }
}

// ── Chroma-gate isolation ──────────────────────────────────────────────

/// Colors whose chroma is below CHROMA_GATE_C0 have zero gate weight
/// and are returned exactly unchanged even with non-zero sliders.
#[test]
fn very_low_chroma_is_unchanged() {
    // Construct a near-neutral with C ≪ CHROMA_GATE_C0
    let tiny_c = CHROMA_GATE_C0 * 0.1;
    let rgb = crate::color::oklab::oklab_to_rec2020([0.5, tiny_c, 0.0]);
    let mut hue = zero_bands();
    hue[0] = 100.0;
    let mut sat = zero_bands();
    for i in 0..BANDS {
        sat[i] = 100.0;
    }
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = rgb;
    let before = img.pixels[0];
    apply(&mut img, &hue, &sat, &zero_bands());
    let after = img.pixels[0];
    for c in 0..3 {
        assert!(
            (after[c] - before[c]).abs() < 1e-4,
            "low-chroma pixel channel {c} changed: {before:?} → {after:?}"
        );
    }
}

// ── Raised-cosine isolation test ──────────────────────────────────────

/// `raised_cosine_weight(0, hw) == 1.0` and `raised_cosine_weight(hw, hw) == 0.0`
#[test]
fn raised_cosine_boundary_values() {
    let hw = BAND_HALF_WIDTH_DEG;
    assert!((raised_cosine_weight(0.0, hw) - 1.0).abs() < 1e-6);
    assert!(raised_cosine_weight(hw, hw).abs() < 1e-6);
    assert!(raised_cosine_weight(hw + 1.0, hw).abs() < 1e-6);
}

// ── #1733 clamp audit: gamut-hull soft-compression parity with saturation/vibrance ──

/// `saturation::apply_pixel` and `vibrance::apply_pixel` both soft-compress
/// chroma toward the Rec.2020 hull (Reinhard knee, C¹-continuous) before
/// converting back from Oklab, so a large positive slider can never drive a
/// channel negative. `hsl::apply_pixel`'s per-band SAT channel scaled chroma
/// with only a non-negativity floor on `c_new` itself (`.max(0.0)`) — a floor
/// on Oklab chroma, NOT a check that the Rec.2020 round-trip stays in
/// `[0, ∞)^3`. A saturated near-hull input pushed further out by SAT+100
/// therefore emitted negative Rec.2020 channels with NO soft-knee, i.e. an
/// un-audited pre-view-transform gap on exactly the axis #1621 fixed for the
/// other two chroma-scaling stages. This test locks the fixed behavior in:
/// every channel must stay non-negative after HSL SAT at its most aggressive
/// per-band setting on a near-hull saturated primary.
#[test]
fn saturation_band_keeps_all_channels_non_negative_near_hull() {
    let cases: [[f32; 3]; 5] = [
        [0.9, 0.05, 0.05], // near-Rec.2020 red
        [0.05, 0.9, 0.05], // near-Rec.2020 green
        [0.05, 0.05, 0.9], // near-Rec.2020 blue
        [0.7, 0.7, 0.05],  // saturated yellow
        [4.0, 0.5, 0.5],   // HDR-headroom saturated red
    ];
    for rgb in cases {
        // Find the band whose center is nearest this pixel's hue and push
        // ONLY that band's saturation to +100 — mirrors how a user would
        // actually drive the defect (a single HSL saturation slider), and
        // matches `saturation_scales_chroma_at_band_center`'s setup.
        let lab = crate::color::oklab::rec2020_to_oklab(rgb);
        let hue = oklab_hue_deg(lab[1], lab[2]);
        let band = (0..BANDS)
            .min_by(|&a, &b| {
                circular_delta_deg(hue, HUE_CENTERS_DEG[a])
                    .partial_cmp(&circular_delta_deg(hue, HUE_CENTERS_DEG[b]))
                    .unwrap()
            })
            .unwrap();
        let mut sat = zero_bands();
        sat[band] = 100.0;

        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = rgb;
        apply(&mut img, &zero_bands(), &sat, &zero_bands());
        let p = img.pixels[0];
        let min = p[0].min(p[1]).min(p[2]);
        assert!(
            min >= -1e-4,
            "input {rgb:?} band {band} SAT+100 → output {p:?} has min channel {min} < 0"
        );
        for c in p {
            assert!(c.is_finite(), "non-finite channel in {:?}", p);
        }
    }
}



// ── #1748 review fix: hue-only rotation can also emit negative channels ──

/// The Rec.2020 hull is not hue-invariant — rotating a near-hull pixel's
/// hue can land it on a narrower part of the hull even when Oklab chroma
/// itself does not increase. An earlier version special-cased
/// `c_target <= c` as "chroma never increases, so gamut can't tighten" and
/// skipped the gamut check entirely on that path — wrong, because hue
/// rotation (applied unconditionally, independent of the SAT slider) can
/// still push a channel negative. This test drives HUE only (SAT = 0, so
/// `c_target == c` exactly) on near-hull primaries and secondaries and
/// asserts every channel stays non-negative.
#[test]
fn hue_only_rotation_keeps_all_channels_non_negative_near_hull() {
    let cases: [[f32; 3]; 6] = [
        [0.95, 0.02, 0.02], // near-Rec.2020 red
        [0.02, 0.95, 0.02], // near-Rec.2020 green
        [0.02, 0.02, 0.95], // near-Rec.2020 blue
        [0.9, 0.9, 0.02],   // near-hull yellow
        [0.9, 0.02, 0.9],   // near-hull magenta
        [0.02, 0.9, 0.9],   // near-hull cyan
    ];
    for rgb in cases {
        let lab = crate::color::oklab::rec2020_to_oklab(rgb);
        let hue = oklab_hue_deg(lab[1], lab[2]);
        let band = (0..BANDS)
            .min_by(|&a, &b| {
                circular_delta_deg(hue, HUE_CENTERS_DEG[a])
                    .partial_cmp(&circular_delta_deg(hue, HUE_CENTERS_DEG[b]))
                    .unwrap()
            })
            .unwrap();
        for hue_deg in [-120.0_f32, -90.0, -60.0, -30.0, 30.0, 60.0, 90.0, 120.0] {
            let mut hue_arr = zero_bands();
            hue_arr[band] = hue_deg;
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = rgb;
            apply(&mut img, &hue_arr, &zero_bands(), &zero_bands());
            let p = img.pixels[0];
            let min = p[0].min(p[1]).min(p[2]);
            assert!(
                min >= -1e-4,
                "input {rgb:?} band {band} HUE={hue_deg} -> output {p:?} has min channel {min} < 0"
            );
            for c in p {
                assert!(c.is_finite(), "non-finite channel in {:?}", p);
            }
        }
    }
}

/// Companion to the HUE-only test above: a modest SAT increase combined
/// with hue rotation toward a narrower hull region must not force chroma
/// back out of gamut via a stale `.max(c_floor)` clamp (the second half of
/// the #1748 review fix — the floor at the pre-HSL input chroma could
/// override the just-bisected hull chroma when the hull at the new hue is
/// narrower than the original input chroma).
#[test]
fn hue_and_sat_combo_keeps_all_channels_non_negative_near_hull() {
    let cases: [[f32; 3]; 6] = [
        [0.95, 0.02, 0.02],
        [0.02, 0.95, 0.02],
        [0.02, 0.02, 0.95],
        [0.9, 0.9, 0.02],
        [0.9, 0.02, 0.9],
        [0.02, 0.9, 0.9],
    ];
    for rgb in cases {
        let lab = crate::color::oklab::rec2020_to_oklab(rgb);
        let hue = oklab_hue_deg(lab[1], lab[2]);
        let band = (0..BANDS)
            .min_by(|&a, &b| {
                circular_delta_deg(hue, HUE_CENTERS_DEG[a])
                    .partial_cmp(&circular_delta_deg(hue, HUE_CENTERS_DEG[b]))
                    .unwrap()
            })
            .unwrap();
        for sat_v in [5.0_f32, 15.0, 30.0, 50.0, 100.0] {
            for hue_deg in [-120.0_f32, -90.0, -60.0, -30.0, 30.0, 60.0, 90.0, 120.0] {
                let mut hue_arr = zero_bands();
                let mut sat_arr = zero_bands();
                hue_arr[band] = hue_deg;
                sat_arr[band] = sat_v;
                let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
                img.pixels[0] = rgb;
                apply(&mut img, &hue_arr, &sat_arr, &zero_bands());
                let p = img.pixels[0];
                let min = p[0].min(p[1]).min(p[2]);
                assert!(
                    min >= -1e-4,
                    "input {rgb:?} band {band} sat={sat_v} HUE={hue_deg} -> output {p:?} has min channel {min} < 0"
                );
                for c in p {
                    assert!(c.is_finite(), "non-finite channel in {:?}", p);
                }
            }
        }
    }
}

