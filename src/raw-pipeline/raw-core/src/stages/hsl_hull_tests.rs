//! Gamut-hull clamp-audit tests for [`super`] (the Oklab HSL color-mixer
//! stage) — the #1733 / #1748 group asserting that per-band SAT and HUE
//! never drive a Rec.2020 channel negative near the hull.
//!
//! Sibling of `hsl_tests.rs` and `hsl_bw_tests.rs`; split out under the
//! 600-LOC file-size budget once the black-and-white mode (#276) landed
//! alongside the #274 smoothness case. Contents moved verbatim.

use super::*;
use crate::image::{ColorSpace, Image};

const BANDS: usize = NUM_BANDS;

fn zero_bands() -> [f32; NUM_BANDS] {
    [0.0; NUM_BANDS]
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
        apply(
            &mut img,
            &zero_bands(),
            &sat,
            &zero_bands(),
            &zero_bands(),
            false,
        );
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
            apply(
                &mut img,
                &hue_arr,
                &zero_bands(),
                &zero_bands(),
                &zero_bands(),
                false,
            );
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
                apply(
                    &mut img,
                    &hue_arr,
                    &sat_arr,
                    &zero_bands(),
                    &zero_bands(),
                    false,
                );
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
