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
    // sharp 0.34.5 on this exact fixture and these exact options moves
    // 200 -> 206 (delta 6) and 60 -> 56 (delta 4); the L* scale (see
    // `SharpenOptions`'s doc comment) is what makes an L*-unit cap of 2
    // correspond to a several-unit sRGB move here, not a tiny one.
    assert!(
        at(&capped, 8, 2).abs_diff(at(&src, 8, 2)) <= 7,
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
fn sharpen_pins_sharp_defaults_on_a_step_edge() {
    // Not `SharpenOptions::default()` — that has `sigma: None`, which is a
    // different code path (`fast_sharpen`, tested below). This pins the
    // mask-based path's own default `m1`/`m2`/`x1`/`y2`/`y3` (a sigma is
    // supplied explicitly; the edge is steep enough to saturate the y2/y3
    // cap for any reasonable sigma, so the exact value doesn't matter) to
    // sharp 0.34.5's measured output on this exact fixture: 60 -> 18,
    // 200 -> 228 (a CIELAB delta of about -19.85/+9.99, i.e. essentially
    // the y3/y2 caps of 20/10).
    let src = step_edge(16, 4);
    let out = src
        .sharpen(&SharpenOptions {
            sigma: Some(1.0),
            ..SharpenOptions::default()
        })
        .unwrap();
    assert!(
        at(&out, 7, 2).abs_diff(18) <= 2,
        "dark side: expected ~18, got {}",
        at(&out, 7, 2)
    );
    assert!(
        at(&out, 8, 2).abs_diff(228) <= 2,
        "bright side: expected ~228, got {}",
        at(&out, 8, 2)
    );
}

#[test]
fn no_argument_sharpen_leaves_a_flat_field_untouched() {
    // sharp's real argument-less `sharpen()` is a fixed 3x3 kernel whose
    // weights sum to its own divisor (24), so a flat field passes through
    // exactly, with no rounding drift at all (unlike the Lab path, which
    // round-trips through CIELAB and can be off by a unit or two).
    let flat = RasterImage::new_rgb(8, 8, vec![120; 8 * 8 * 3]);
    let out = flat
        .sharpen(&SharpenOptions {
            sigma: None,
            ..SharpenOptions::default()
        })
        .unwrap();
    assert!(
        out.data.iter().all(|&v| v == 120),
        "a flat field must be exactly unchanged by the fixed kernel"
    );
}

#[test]
fn no_argument_sharpen_pushes_a_step_edge_apart() {
    // sharp's fixed no-argument kernel `[-1,-1,-1; -1,32,-1; -1,-1,-1] / 24`
    // applied directly to the colour bytes (no Lab) on the 16x4 60/200 step
    // edge, worked out by hand with clamp-to-edge addressing at (7, 2) and
    // (8, 2) (both interior rows, so only the x clamp ever matters):
    //   (7,2): -3*60 (x=6) + 30*60 (x=7) + -3*200 (x=8) = 1020; /24 = 42.5
    //   (8,2): -3*60 (x=7) + 30*200 (x=8) + -3*200 (x=9) = 5220; /24 = 217.5
    // Both are exact halves, and libvips' integer convolution path
    // truncates rather than rounds — sharp 0.34.5 measures 42/217 here,
    // confirmed two independent ways (`.sharpen()` and an equivalent
    // `.convolve()` call with this exact kernel), not `f64::round`'s
    // round-half-away-from-zero 43/218.
    let src = step_edge(16, 4);
    let out = src
        .sharpen(&SharpenOptions {
            sigma: None,
            ..SharpenOptions::default()
        })
        .unwrap();
    assert_eq!(at(&out, 7, 2), 42, "dark side did not deepen as expected");
    assert_eq!(at(&out, 8, 2), 217, "bright side did not lift as expected");
    assert!(at(&out, 7, 2) < at(&src, 7, 2));
    assert!(at(&out, 8, 2) > at(&src, 8, 2));
}

#[test]
fn no_argument_sharpen_truncates_a_non_half_sum_too() {
    // A non-tie case, to pin that the truncating divide doesn't disturb an
    // ordinary fraction — both truncation and round-to-nearest land on the
    // same integer here, unlike the exact-.5 cases above.
    //
    // A 3x3 image, centre pixel 201, the 8 neighbours all 50: applying the
    // kernel at the centre (no clamping needed, every tap is in-bounds):
    //   -1*50 (three times, top row) + -1*50 (left) + 32*201 (centre)
    //     + -1*50 (right) + -1*50 (three times, bottom row)
    //   = 32*201 - 8*50 = 6432 - 400 = 6032; /24 = 251.33... -> 251
    let mut data = vec![50u8; 3 * 3 * 3];
    let centre = ((1 * 3 + 1) * 3) as usize;
    data[centre] = 201;
    data[centre + 1] = 201;
    data[centre + 2] = 201;
    let img = RasterImage::new_rgb(3, 3, data);
    let out = img
        .sharpen(&SharpenOptions {
            sigma: None,
            ..SharpenOptions::default()
        })
        .unwrap();
    assert_eq!(at(&out, 1, 1), 251);
}

#[test]
fn no_argument_sharpen_convolves_the_alpha_band_too() {
    // `image.conv(mask)` has no band exclusion, so the argument-less
    // sharpen sharpens alpha along with colour — the mask-based (Lab) path
    // is the one that leaves alpha alone. Measured on sharp 0.34.5 over a
    // 4x1 RGBA ramp whose alpha ramps 40..43: alpha comes back 39, 41, 42,
    // 43, not the source's 40, 41, 42, 43.
    let src = RasterImage::new_rgba(
        4,
        1,
        vec![
            0, 20, 30, 40, 10, 20, 30, 41, 20, 20, 30, 42, 30, 20, 30, 43,
        ],
    );
    let out = src.sharpen(&SharpenOptions::default()).unwrap();
    assert_eq!(
        out.data,
        vec![0, 19, 25, 39, 5, 18, 24, 41, 18, 18, 23, 42, 31, 17, 30, 43]
    );
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
fn an_out_of_range_transfer_parameter_is_named() {
    // #3504 task E5 controller ruling (b): m1/m2/x1/y2/y3 all share sharp's
    // own [0, 1000000] domain (`lib/operation.js`'s `is.inRange` checks on
    // `options.m1`/`m2`/`x1`/`y2`/`y3`), and a violation is named by field —
    // one case per field, each checked in isolation with the other four
    // left at sharp's own defaults.
    let src = step_edge(4, 4);
    let cases: &[(&str, SharpenOptions)] = &[
        (
            "m1",
            SharpenOptions {
                sigma: Some(1.0),
                m1: -1.0,
                ..SharpenOptions::default()
            },
        ),
        (
            "m2",
            SharpenOptions {
                sigma: Some(1.0),
                m2: 2_000_000.0,
                ..SharpenOptions::default()
            },
        ),
        (
            "x1",
            SharpenOptions {
                sigma: Some(1.0),
                x1: f64::NAN,
                ..SharpenOptions::default()
            },
        ),
        (
            "y2",
            SharpenOptions {
                sigma: Some(1.0),
                y2: -0.1,
                ..SharpenOptions::default()
            },
        ),
        (
            "y3",
            SharpenOptions {
                sigma: Some(1.0),
                y3: 1_000_001.0,
                ..SharpenOptions::default()
            },
        ),
    ];
    for (name, options) in cases {
        let err = src.sharpen(options).unwrap_err();
        assert!(
            err.to_string().contains(name),
            "expected the error to name {name}, got: {err}"
        );
    }
}

#[test]
fn transfer_parameters_at_sharps_own_boundary_values_are_accepted() {
    // The domain is inclusive on both ends — 0 and 1000000 are valid, not
    // one-past-the-edge rejections.
    let src = step_edge(4, 4);
    assert!(src
        .sharpen(&SharpenOptions {
            sigma: Some(1.0),
            m1: 0.0,
            m2: 1_000_000.0,
            x1: 0.0,
            y2: 1_000_000.0,
            y3: 0.0,
            ..SharpenOptions::default()
        })
        .is_ok());
}

#[test]
fn the_colour_round_trip_is_exact_not_merely_close() {
    // The closed-form guarantee the whole mask-based path leans on, and the
    // reason `sharpen` converts through `raster_labs` rather than a
    // textbook CIELAB pair: a byte in comes back unchanged, so
    // `sharpen_leaves_a_flat_field_untouched` and
    // `m1_and_m2_zero_returns_the_source` above are testing the transfer
    // function and not conversion noise. `raster_labs_tests.rs` sweeps the
    // whole cube; this pins the corners through `sharpen` itself.
    for &(r, g, b) in &[
        (0u8, 0u8, 0u8),
        (255, 255, 255),
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (120, 120, 120),
        (60, 90, 200),
    ] {
        let flat = RasterImage::new_rgb(4, 4, [r, g, b].repeat(16));
        let out = flat
            .sharpen(&SharpenOptions {
                sigma: Some(1.5),
                ..SharpenOptions::default()
            })
            .unwrap();
        assert_eq!(out.data, flat.data, "({r}, {g}, {b}) did not round trip");
    }
}
