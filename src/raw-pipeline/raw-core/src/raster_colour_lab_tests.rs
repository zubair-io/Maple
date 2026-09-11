//! Tests for `raster_colour_lab.rs` (tint, modulate, normalise), split out
//! per the file-budget split pattern `view/encode.rs` uses for its own
//! sibling test files (`encode_p3_tests.rs`, `encode_quantize_tests.rs`).

use super::*;

fn px(img: &RasterImage) -> [u8; 3] {
    [img.data[0], img.data[1], img.data[2]]
}

#[test]
fn tinting_with_a_neutral_grey_desaturates() {
    // Grey has a* = b* = 0, so the result keeps L* and loses all chroma
    // regardless of the luminance weight.
    let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
    let tinted = img.tint([128, 128, 128]);
    let out = px(&tinted);
    assert!(
        out[0].abs_diff(out[1]) <= 1 && out[1].abs_diff(out[2]) <= 1,
        "expected a neutral pixel, got {out:?}"
    );
}

#[test]
fn tint_preserves_the_lightness_of_each_pixel() {
    // Grey inputs: Rec.709 luma of an R=G=B pixel reproduces the same
    // byte exactly, so this exercises the weighted formula without the
    // luma-reduction step itself introducing drift.
    let img = RasterImage::new_rgb(2, 1, vec![30, 30, 30, 220, 220, 220]);
    let tinted = img.tint([255, 240, 16]);
    let before = [
        srgb_to_lab([30, 30, 30])[0],
        srgb_to_lab([220, 220, 220])[0],
    ];
    let after = [
        srgb_to_lab([tinted.data[0], tinted.data[1], tinted.data[2]])[0],
        srgb_to_lab([tinted.data[3], tinted.data[4], tinted.data[5]])[0],
    ];
    for i in 0..2 {
        assert!(
            (before[i] - after[i]).abs() < 1.5,
            "L* {} -> {}",
            before[i],
            after[i]
        );
    }
}

#[test]
fn tint_leaves_alpha_unchanged() {
    let img = RasterImage::new_rgba(1, 1, vec![200, 40, 40, 33]);
    assert_eq!(img.tint([0, 0, 255]).data[3], 33);
}

#[test]
fn tint_reddens_a_neutral_grey_without_moving_its_lightness() {
    // A neutral grey tinted red gains positive a* (redder) while L*
    // stays put — the closed-form assertion the brief calls out.
    let img = RasterImage::new_rgb(1, 1, vec![128, 128, 128]);
    let l_before = srgb_to_lab([128, 128, 128])[0];
    let tinted = img.tint([255, 0, 0]);
    let lab_after = srgb_to_lab(px(&tinted));
    assert!(lab_after[1] > 0.0, "expected a* > 0, got {}", lab_after[1]);
    assert!(
        (lab_after[0] - l_before).abs() < 0.5,
        "L* {} -> {}",
        l_before,
        lab_after[0]
    );
}

#[test]
fn black_and_white_are_unchanged_by_any_tint() {
    // w = 1 - 4*(l - 0.5)^2 is exactly 0 at l = 0 and l = 1, so pure
    // black and pure white keep their own value regardless of tint.
    for v in [0u8, 255] {
        let img = RasterImage::new_rgb(1, 1, vec![v, v, v]);
        let out = px(&img.tint([255, 240, 16]));
        assert!(
            out[0].abs_diff(v) <= 1 && out[1].abs_diff(v) <= 1 && out[2].abs_diff(v) <= 1,
            "grey {v} -> {out:?}"
        );
    }
}

#[test]
fn mid_grey_gains_the_most_chroma_from_a_tint() {
    // The luminance weight peaks at L* = 50 (sRGB grey ~118-119) and
    // falls off toward both black and white, so a mid-grey tinted red
    // should pick up more a* than either a dark or a light grey.
    let tint = [255, 0, 0];
    let a_of = |v: u8| {
        let img = RasterImage::new_rgb(1, 1, vec![v, v, v]);
        srgb_to_lab(px(&img.tint(tint)))[1]
    };
    let dark = a_of(40);
    let mid = a_of(118);
    let light = a_of(220);
    assert!(mid > dark, "mid a* {mid} should exceed dark a* {dark}");
    assert!(mid > light, "mid a* {mid} should exceed light a* {light}");
}

#[test]
fn tint_leaves_a_four_channel_image_alpha_alone_across_the_luma_lut() {
    let img = RasterImage::new_rgba(2, 1, vec![40, 40, 40, 10, 220, 220, 220, 250]);
    let tinted = img.tint([255, 240, 16]);
    assert_eq!(tinted.channels, 4);
    assert_eq!(tinted.data[3], 10);
    assert_eq!(tinted.data[7], 250);
}

#[test]
fn modulate_identity_changes_nothing() {
    let img = RasterImage::new_rgb(1, 1, vec![90, 130, 70]);
    let out = img.modulate(1.0, 1.0, 0.0, 0.0);
    for i in 0..3 {
        assert!(out.data[i].abs_diff(img.data[i]) <= 1, "{:?}", out.data);
    }
}

#[test]
fn brightness_scales_l_star() {
    let img = RasterImage::new_rgb(1, 1, vec![128, 128, 128]);
    let out = img.modulate(0.5, 1.0, 0.0, 0.0);
    let l_before = srgb_to_lab([128, 128, 128])[0];
    let l_after = srgb_to_lab(px(&out))[0];
    assert!(
        (l_after - l_before * 0.5).abs() < 1.0,
        "{l_before} -> {l_after}"
    );
}

#[test]
fn saturation_zero_produces_a_neutral_pixel() {
    let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
    let out = px(&img.modulate(1.0, 0.0, 0.0, 0.0));
    assert!(
        out[0].abs_diff(out[1]) <= 1 && out[1].abs_diff(out[2]) <= 1,
        "{out:?}"
    );
}

#[test]
fn a_360_degree_hue_rotation_is_identity() {
    let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
    let out = img.modulate(1.0, 1.0, 360.0, 0.0);
    for i in 0..3 {
        assert!(out.data[i].abs_diff(img.data[i]) <= 1, "{:?}", out.data);
    }
}

#[test]
fn hue_180_on_pure_red_lands_on_cyan_ish() {
    // Pure red sits at hue ~40 degrees in LCh; rotating 180 degrees
    // should land on the opposite side of the wheel — negative a*.
    let img = RasterImage::new_rgb(1, 1, vec![255, 0, 0]);
    let out = px(&img.modulate(1.0, 1.0, 180.0, 0.0));
    let lab_after = srgb_to_lab(out);
    assert!(lab_after[1] < 0.0, "expected a* < 0, got {}", lab_after[1]);
}

#[test]
fn lightness_adds_to_l_star() {
    let img = RasterImage::new_rgb(1, 1, vec![100, 100, 100]);
    let l_before = srgb_to_lab([100, 100, 100])[0];
    let l_after = srgb_to_lab(px(&img.modulate(1.0, 1.0, 0.0, 10.0)))[0];
    assert!(
        (l_after - (l_before + 10.0)).abs() < 1.0,
        "{l_before} -> {l_after}"
    );
}

#[test]
fn modulate_leaves_alpha_unchanged() {
    let img = RasterImage::new_rgba(1, 1, vec![200, 40, 40, 12]);
    assert_eq!(img.modulate(0.5, 2.0, 90.0, 0.0).data[3], 12);
}

/// A horizontal L* ramp compressed into the middle of the range: every
/// pixel is grey with a value between 64 and 192.
fn compressed_ramp() -> RasterImage {
    let data = (0..129u32)
        .flat_map(|i| {
            let v = (64 + i / 2) as u8;
            [v, v, v]
        })
        .collect();
    RasterImage::new_rgb(129, 1, data)
}

#[test]
fn normalise_stretches_the_luminance_to_the_full_range() {
    // Measured against sharp 0.34.5 on this exact fixture: the darkest
    // pixel lands at 1 (not 0) and the brightest at 254 (not 255) —
    // sharp does not nudge the percentile bounds to force an exact
    // touch of both ends.
    let out = compressed_ramp().normalise(0.0, 100.0);
    assert!(
        out.data[0] <= 1,
        "the darkest pixel should near black, got {}",
        out.data[0]
    );
    assert!(
        out.data[out.data.len() - 1] >= 254,
        "the brightest should near white, got {}",
        out.data[out.data.len() - 1]
    );
}

#[test]
fn normalise_of_a_full_range_image_is_close_to_identity() {
    let data = (0..256u32)
        .flat_map(|i| [i as u8, i as u8, i as u8])
        .collect();
    let img = RasterImage::new_rgb(256, 1, data);
    let out = img.normalise(0.0, 100.0);
    let worst = out
        .data
        .iter()
        .zip(&img.data)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    // sharp 0.34.5 is byte-exact on this fixture: percentile(0) and
    // percentile(100) land on the histogram's actual endpoints (0 and
    // 100), so the stretch is a true no-op.
    assert_eq!(worst, 0, "worst channel drift was {worst}");
}

#[test]
fn normalise_leaves_a_flat_image_alone() {
    // max - min is 0, so libvips skips the stretch entirely.
    let img = RasterImage::new_rgb(4, 1, vec![120; 12]);
    assert_eq!(img.normalise(1.0, 99.0).data, img.data);
}

#[test]
fn normalise_keeps_chroma_and_alpha() {
    let img = RasterImage::new_rgba(2, 1, vec![180, 40, 40, 90, 60, 20, 20, 91]);
    let out = img.normalise(0.0, 100.0);
    assert_eq!(out.data[3], 90);
    assert_eq!(out.data[7], 91);
    // Still reddish: the red channel stays the largest.
    assert!(out.data[0] > out.data[1] && out.data[0] > out.data[2]);
}

#[test]
fn the_percentile_bounds_clip_the_extremes() {
    // One black pixel among 100 mid-greys: with only ~1% of the pixels
    // below the grey population, percentile(5) and percentile(95) both
    // land on the grey bin. Measured against sharp 0.34.5 on this exact
    // fixture: sharp does NOT fall back to the histogram's true min/max
    // in that case — it treats the collapsed bounds as flat and returns
    // the image byte-identical, same as `normalise_leaves_a_flat_image_alone`.
    let mut data: Vec<u8> = vec![0, 0, 0];
    data.extend((0..100).flat_map(|_| [128u8, 128, 128]));
    let img = RasterImage::new_rgb(101, 1, data);
    let clipped = img.normalise(5.0, 95.0);
    assert_eq!(clipped.data, img.data, "sharp returns this image unchanged");
}

#[test]
fn white_and_black_are_fixed_points_of_the_p3_rotation() {
    let img = RasterImage::new_rgb(2, 1, vec![255, 255, 255, 0, 0, 0]);
    let p3 = img.to_colourspace(TargetPrimaries::Srgb, TargetPrimaries::P3);
    assert_eq!(
        &p3.data[..3],
        &[255, 255, 255],
        "both spaces share D65 white"
    );
    assert_eq!(&p3.data[3..], &[0, 0, 0]);
}

#[test]
fn saturated_srgb_red_shrinks_inside_p3() {
    // P3 is the wider gamut, so the same stimulus needs LESS red and a
    // little green/blue to be expressed in it.
    let img = RasterImage::new_rgb(1, 1, vec![255, 0, 0]);
    let p3 = img.to_colourspace(TargetPrimaries::Srgb, TargetPrimaries::P3);
    assert!(
        p3.data[0] > 200 && p3.data[0] <= 255,
        "R was {}",
        p3.data[0]
    );
    assert!(p3.data[1] > 0, "G should gain a little, was {}", p3.data[1]);
}

#[test]
fn srgb_to_srgb_is_identity() {
    let img = RasterImage::new_rgb(1, 1, vec![33, 144, 210]);
    assert_eq!(
        img.to_colourspace(TargetPrimaries::Srgb, TargetPrimaries::Srgb)
            .data,
        img.data
    );
}

#[test]
fn the_colourspace_rotation_round_trips() {
    let img = RasterImage::new_rgb(1, 1, vec![120, 90, 200]);
    let back = img
        .to_colourspace(TargetPrimaries::Srgb, TargetPrimaries::P3)
        .to_colourspace(TargetPrimaries::P3, TargetPrimaries::Srgb);
    for i in 0..3 {
        assert!(back.data[i].abs_diff(img.data[i]) <= 2, "{:?}", back.data);
    }
}

#[test]
fn to_colourspace_leaves_alpha_alone() {
    let img = RasterImage::new_rgba(1, 1, vec![255, 0, 0, 44]);
    assert_eq!(
        img.to_colourspace(TargetPrimaries::Srgb, TargetPrimaries::P3)
            .data[3],
        44
    );
}
