use super::*;

fn at(img: &RasterImage, x: u32, y: u32) -> u8 {
    img.data[((y * img.width + x) * img.channels as u32) as usize]
}

/// A vertical step edge: the left half is 60, the right half is 200.
fn step_edge(w: u32, h: u32) -> RasterImage {
    let data = (0..h)
        .flat_map(|_| {
            (0..w).flat_map(move |x| {
                let v = if x < w / 2 { 60u8 } else { 200u8 };
                [v, v, v]
            })
        })
        .collect();
    RasterImage::new_rgb(w, h, data)
}

#[test]
fn sharpen_overshoots_on_both_sides_of_an_edge() {
    let src = step_edge(16, 4);
    let out = src
        .sharpen(&SharpenOptions {
            sigma: Some(1.5),
            ..SharpenOptions::default()
        })
        .unwrap();
    // The dark side just before the edge gets darker, the bright side just
    // after it gets brighter — that IS an unsharp mask.
    assert!(at(&out, 7, 2) < at(&src, 7, 2), "dark side did not deepen");
    assert!(at(&out, 8, 2) > at(&src, 8, 2), "bright side did not lift");
}

#[test]
fn sharpen_leaves_a_flat_field_untouched() {
    let flat = RasterImage::new_rgb(8, 8, vec![120; 8 * 8 * 3]);
    let out = flat
        .sharpen(&SharpenOptions {
            sigma: Some(2.0),
            ..SharpenOptions::default()
        })
        .unwrap();
    for (a, b) in out.data.iter().zip(&flat.data) {
        assert!(a.abs_diff(*b) <= 1, "a flat field must stay flat");
    }
}

#[test]
fn m1_zero_suppresses_sharpening_in_flat_areas() {
    // With m1 = 0 the below-x1 differences are zeroed, so a near-flat
    // gradient comes back essentially unchanged.
    let gentle = RasterImage::new_rgb(
        16,
        1,
        (0..16u32)
            .flat_map(|x| {
                let v = (100 + x / 8) as u8;
                [v, v, v]
            })
            .collect(),
    );
    let out = gentle
        .sharpen(&SharpenOptions {
            sigma: Some(1.0),
            m1: 0.0,
            ..SharpenOptions::default()
        })
        .unwrap();
    for (a, b) in out.data.iter().zip(&gentle.data) {
        assert!(
            a.abs_diff(*b) <= 2,
            "m1 = 0 should leave a gentle gradient alone"
        );
    }
}

#[test]
fn y2_and_y3_cap_the_overshoot() {
    let src = step_edge(16, 4);
    let capped = src
        .sharpen(&SharpenOptions {
            sigma: Some(2.0),
            m2: 20.0,
            y2: 2.0,
            y3: 2.0,
            ..SharpenOptions::default()
        })
        .unwrap();
    assert!(
        at(&capped, 8, 2).abs_diff(at(&src, 8, 2)) <= 3,
        "y2 should have capped the brightening"
    );
}

#[test]
fn sharpen_preserves_the_alpha_channel() {
    let data = (0..16u32)
        .flat_map(|x| {
            let v = if x < 8 { 60u8 } else { 200 };
            [v, v, v, 42]
        })
        .collect();
    let img = RasterImage::new_rgba(16, 1, data);
    let out = img
        .sharpen(&SharpenOptions {
            sigma: Some(1.5),
            ..SharpenOptions::default()
        })
        .unwrap();
    assert!(
        out.data.chunks_exact(4).all(|p| p[3] == 42),
        "alpha must not be sharpened"
    );
}

#[test]
fn the_default_sharpen_is_a_mild_3x3() {
    let src = step_edge(16, 4);
    let out = src.sharpen(&SharpenOptions::default()).unwrap();
    assert!(at(&out, 8, 2) > at(&src, 8, 2));
}

#[test]
fn m1_and_m2_zero_returns_the_source() {
    // A zeroed transfer means the added difference is 0 everywhere, so the
    // only change possible is float round-trip noise through Lab — bounded
    // to a couple of 8-bit steps rather than an actual sharpening effect.
    let src = step_edge(16, 4);
    let out = src
        .sharpen(&SharpenOptions {
            sigma: Some(1.5),
            m1: 0.0,
            m2: 0.0,
            ..SharpenOptions::default()
        })
        .unwrap();
    for (a, b) in out.data.iter().zip(&src.data) {
        assert!(a.abs_diff(*b) <= 2, "m1 = m2 = 0 must return the source");
    }
}

#[test]
fn an_out_of_range_sigma_is_rejected() {
    let src = step_edge(4, 4);
    assert!(src
        .sharpen(&SharpenOptions {
            sigma: Some(0.0),
            ..SharpenOptions::default()
        })
        .is_err());
    assert!(src
        .sharpen(&SharpenOptions {
            sigma: Some(2000.0),
            ..SharpenOptions::default()
        })
        .is_err());
}

#[test]
fn a_nan_sigma_is_rejected_by_name() {
    let src = step_edge(4, 4);
    let err = src
        .sharpen(&SharpenOptions {
            sigma: Some(f64::NAN),
            ..SharpenOptions::default()
        })
        .unwrap_err();
    assert!(
        err.to_string().contains("NaN"),
        "expected the error to name NaN, got: {err}"
    );
}

#[test]
fn lab_round_trip_is_stable_for_srgb_bytes() {
    // Not part of the brief's test list, but the closed-form guarantee the
    // whole filter leans on: converting to Lab and back must be
    // (near-)lossless, or `sharpen_leaves_a_flat_field_untouched` and
    // `m1_and_m2_zero_returns_the_source` above would be testing rounding
    // noise instead of the transfer function.
    for &(r, g, b) in &[
        (0u8, 0u8, 0u8),
        (255, 255, 255),
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (120, 120, 120),
        (60, 90, 200),
    ] {
        let lab = srgb_to_lab([r, g, b]);
        let back = lab_to_srgb(lab);
        assert!(
            (back[0] as i16 - r as i16).abs() <= 1
                && (back[1] as i16 - g as i16).abs() <= 1
                && (back[2] as i16 - b as i16).abs() <= 1,
            "Lab round trip drifted too far for ({r}, {g}, {b}): got {back:?}"
        );
    }
}
