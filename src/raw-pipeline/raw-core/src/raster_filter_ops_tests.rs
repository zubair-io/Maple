use super::*;

/// A single white pixel at the centre of a black `n`x`n` field. Mirrors
/// `raster_filter_tests.rs`'s helper of the same name — duplicated rather
/// than shared because `#[cfg(test)]` sibling modules don't share bindings.
fn impulse(n: u32) -> RasterImage {
    let centre = n / 2;
    let data = (0..n)
        .flat_map(|y| {
            (0..n).flat_map(move |x| {
                if x == centre && y == centre {
                    [255u8, 255, 255]
                } else {
                    [0, 0, 0]
                }
            })
        })
        .collect();
    RasterImage::new_rgb(n, n, data)
}

/// A vertical step edge: the left half is 60, the right half is 200.
/// Mirrors `raster_sharpen_tests.rs`'s helper of the same name.
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

fn at(img: &RasterImage, x: u32, y: u32) -> u8 {
    img.data[((y * img.width + x) * img.channels as u32) as usize]
}

// ---------------------------------------------------------------- median ---

#[test]
fn median_removes_a_salt_and_pepper_speck() {
    // 5x5 mid-grey with one white pixel: a 3x3 median erases it.
    let mut data = vec![100u8; 5 * 5 * 3];
    let centre = ((2 * 5 + 2) * 3) as usize;
    data[centre..centre + 3].copy_from_slice(&[255, 255, 255]);
    let img = RasterImage::new_rgb(5, 5, data);
    let out = img.median(3).unwrap();
    assert_eq!(at(&out, 2, 2), 100);
}

#[test]
fn median_preserves_a_step_edge() {
    // The distinguishing property of a median filter versus a blur.
    let src = step_edge(16, 4);
    let out = src.median(3).unwrap();
    assert_eq!(at(&out, 7, 2), 60);
    assert_eq!(at(&out, 8, 2), 200);
}

#[test]
fn median_rejects_only_zero_not_an_even_window() {
    // #3504 task E5 controller ruling (c): sharp/`vips_rank` accepts even
    // windows, so only `size == 0` (and the ceiling, covered separately)
    // is rejected now — `median(2)` must succeed.
    assert!(impulse(5).median(2).is_ok());
    assert!(impulse(5).median(0).is_err());
}

#[test]
fn median_size_2_matches_sharps_asymmetric_window() {
    // Measured against sharp 0.34.5: a lone bright column (value 100) in an
    // otherwise-flat 12x12 field of 0, `median(2)`'d, comes back with the
    // spike visible at its own column AND the column to its RIGHT, never
    // the column to its left — `sharp(raw).median(2).raw().toBuffer()` on
    // this exact fixture gives `[...,0,0,0,0,0,100,100,0,0,0,0,0]` (indices
    // 0-11), spike at column 5 in the input. That pins the window at pixel
    // `x` as `[x-1, x]` (one tap low, none high), not `[x, x+1]` — see
    // `median`'s doc comment for the general `before`/`after` formula this
    // one case is checking.
    let w = 12u32;
    let h = 12u32;
    let data: Vec<u8> = (0..h)
        .flat_map(|_| (0..w).flat_map(|x| if x == 5 { [100u8; 3] } else { [0u8; 3] }))
        .collect();
    let img = RasterImage::new_rgb(w, h, data);
    let out = img.median(2).unwrap();
    let row: Vec<u8> = (0..w).map(|x| at(&out, x, 6)).collect();
    let mut expected = vec![0u8; w as usize];
    expected[5] = 100;
    expected[6] = 100;
    assert_eq!(row, expected);
}

#[test]
fn median_rejects_a_window_over_the_1000_ceiling() {
    // sharp validates the window as an integer >= 1 with no documented
    // ceiling; this crate caps it at 1000 (an O(size^2) rank-sort per pixel
    // otherwise has no bound at all) and names the offending value.
    let err = impulse(5).median(1001).unwrap_err();
    assert!(err.to_string().contains("1001"));
}

#[test]
fn median_filters_alpha_too() {
    // 8x3 rather than 8x1 because `vips_rank` refuses a window taller than
    // the image, so a 3x3 median on a single row is an error in sharp too
    // (see `median_rejects_a_window_larger_than_the_image`).
    let data = (0..3u32)
        .flat_map(|y| {
            (0..8u32).flat_map(move |x| [90u8, 90, 90, if x == 4 && y == 1 { 0 } else { 255 }])
        })
        .collect();
    let img = RasterImage::new_rgba(8, 3, data);
    let out = img.median(3).unwrap();
    assert_eq!(
        out.data[(1 * 8 + 4) * 4 + 3],
        255,
        "the lone transparent pixel is a speck"
    );
}

#[test]
fn median_rejects_a_window_larger_than_the_image() {
    // `vips_rank` errors with "window too large" rather than clamping to
    // the edge. Measured on sharp 0.34.5: `median(3)` on a 1x1 and
    // `median(5)` on a 4x4 both throw, `median(4)` on the 4x4 does not, and
    // on an 8x4 the cutoff is the shorter axis — `median(4)` passes,
    // `median(5)` throws.
    let err = RasterImage::new_rgb(1, 1, vec![7, 7, 7])
        .median(3)
        .unwrap_err();
    assert!(err.to_string().contains("1x1"), "got: {err}");
    assert!(err.to_string().contains("window too large"), "got: {err}");

    let wide = RasterImage::new_rgb(8, 4, vec![7; 8 * 4 * 3]);
    assert!(wide.median(4).is_ok());
    assert!(wide.median(5).is_err());
}

// ------------------------------------------------------------- threshold ---

#[test]
fn threshold_zero_is_a_no_op() {
    // sharp gates its whole threshold stage on `threshold != 0`, and its JS
    // layer resolves `threshold(false)` to 0, so neither form touches the
    // image. Measured on sharp 0.34.5: byte-identical to the source, where
    // a literal `pixel >= 0` gives max diff 255 on 3060 of 3072 samples of
    // a noise fixture.
    let src = RasterImage::new_rgba(2, 2, (0..4).flat_map(|i| [i * 40, 7, 200, 128]).collect());
    assert_eq!(src.threshold(0, true).unwrap().data, src.data);
    assert_eq!(src.threshold(0, false).unwrap().data, src.data);
}

#[test]
fn bw_luma_matches_sharps_black_and_white_conversion() {
    // Measured against sharp 0.34.5's `toColourspace('b-w')` (what
    // `threshold({greyscale: true})` actually runs): linearize each
    // channel, take the Rec.709-weighted LINEAR luminance, then re-encode
    // with the sRGB OETF. A naive weighted sum of the encoded bytes would
    // give 54 / 182 / 168 for these three inputs instead of sharp's real
    // 127 / 220 / 178 — pinning the number itself here, not just the 0/255
    // outcome, so a regression to the naive formula can't hide.
    assert_eq!(bw_luma([255, 0, 0]), 127);
    assert_eq!(bw_luma([0, 255, 0]), 220);
    assert_eq!(bw_luma([100, 200, 50]), 178);
}

#[test]
fn threshold_binarises_through_greyscale_by_default() {
    // Linear-light Rec.709 luma of pure red is 127 (see `bw_luma`'s pinned
    // test), which is below 128 -> black.
    let img = RasterImage::new_rgb(2, 1, vec![255, 0, 0, 0, 255, 0]);
    let out = img.threshold(128, true).unwrap();
    assert_eq!(&out.data[..3], &[0, 0, 0]);
    // Linear-light luma of pure green is 220, above 128 -> white.
    assert_eq!(&out.data[3..], &[255, 255, 255]);
}

#[test]
fn threshold_without_greyscale_binarises_each_channel() {
    let img = RasterImage::new_rgb(1, 1, vec![255, 0, 130]);
    assert_eq!(img.threshold(128, false).unwrap().data, vec![255, 0, 255]);
}

#[test]
fn threshold_closed_form_100_200_pair() {
    // A neutral grey pair (equal r/g/b): `bw_luma` round-trips a neutral
    // value back to itself (the sRGB OETF/EOTF are exact inverses and the
    // Rec.709 weights sum to 1.0), so greyscale's weighted luma and a plain
    // per-channel comparison agree here: 100 < 128 -> 0, 200 >= 128 -> 255.
    let img = RasterImage::new_rgb(2, 1, vec![100, 100, 100, 200, 200, 200]);
    assert_eq!(
        img.threshold(128, true).unwrap().data,
        vec![0, 0, 0, 255, 255, 255]
    );
}

#[test]
fn threshold_thresholds_alpha_too() {
    // sharp's threshold is a plain `image >= value` comparison over every
    // band, alpha included — not exempted like `convolve`'s colour-only
    // predecessor logic, and not routed through `bw_luma` either.
    let low = RasterImage::new_rgba(1, 1, vec![255, 255, 255, 64]);
    assert_eq!(low.threshold(128, true).unwrap().data[3], 0);
    let high = RasterImage::new_rgba(1, 1, vec![255, 255, 255, 200]);
    assert_eq!(high.threshold(128, true).unwrap().data[3], 255);
}

// -------------------------------------------------------------- convolve ---

#[test]
fn convolve_with_an_identity_kernel_is_identity() {
    let src = step_edge(8, 2);
    let out = src
        .convolve(
            3,
            3,
            &[0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            1.0,
            0.0,
        )
        .unwrap();
    assert_eq!(out.data, src.data);
}

#[test]
fn convolve_runs_a_horizontal_sobel() {
    // Sobel on a left-to-right step edge: the response peaks at the edge
    // and is zero in the flat regions. scale = 1, offset = 128 keeps the
    // signed result visible in 8 bits.
    let src = step_edge(8, 4);
    let out = src
        .convolve(
            3,
            3,
            &[-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0],
            1.0,
            128.0,
        )
        .unwrap();
    assert_eq!(at(&out, 1, 2), 128, "flat region should sit at the offset");
    assert!(at(&out, 4, 2) > 200, "the edge should ring the detector");
}

#[test]
fn convolve_defaults_the_scale_to_the_kernel_sum() {
    // A 3x3 box with scale 9 averages; passing scale 0 means "use the sum".
    let flat = RasterImage::new_rgb(5, 5, vec![80; 5 * 5 * 3]);
    let out = flat.convolve(3, 3, &[1.0; 9], 0.0, 0.0).unwrap();
    assert!(out.data.iter().all(|&v| v == 80));
}

#[test]
fn convolve_rejects_a_kernel_whose_length_disagrees() {
    assert!(impulse(5).convolve(3, 3, &[1.0; 8], 1.0, 0.0).is_err());
    assert!(impulse(5).convolve(0, 3, &[], 1.0, 0.0).is_err());
}

#[test]
fn convolve_rejects_a_nan_kernel_value() {
    let mut kernel = vec![1.0; 9];
    kernel[4] = f64::NAN;
    let err = impulse(5).convolve(3, 3, &kernel, 9.0, 0.0).unwrap_err();
    assert!(err.to_string().contains("NaN"));
}

#[test]
fn convolve_box_3x3_on_an_impulse_truncates_255_over_9_to_28() {
    // Measured against sharp 0.34.5 (`.convolve({width:3,height:3,
    // kernel:[1]*9, scale:9, offset:0})` on the same 5x5 impulse fixture):
    // every cell of the 3x3 block around the impulse comes out 28, not the
    // rounded 28.33 -> 28 (same value here either way, but see the
    // Sobel-adjacent case in the module doc for a case where truncation and
    // rounding actually disagree and sharp's output confirms truncation).
    let out = impulse(5).convolve(3, 3, &[1.0; 9], 9.0, 0.0).unwrap();
    for y in 1..=3 {
        for x in 1..=3 {
            assert_eq!(at(&out, x, y), 28, "cell ({x},{y}) should be 28");
        }
    }
    assert_eq!(at(&out, 0, 0), 0, "outside the spread window stays 0");
}

#[test]
fn convolve_truncates_rather_than_rounds_an_integer_kernel() {
    // Measured against sharp 0.34.5 on the 16x4 60/200 step-edge fixture
    // with the same box kernel: row 2, x=7's window (columns 6,7,8, three
    // rows of 60,60,200) sums to 960; 960/9 = 106.67, which *rounds* to 107
    // but sharp's actual output is 106 — libvips' integer convolution path
    // truncates the division rather than rounding it, same as
    // `fast_sharpen` in `raster_sharpen.rs`.
    let src = step_edge(16, 4);
    let out = src.convolve(3, 3, &[1.0; 9], 9.0, 0.0).unwrap();
    assert_eq!(
        at(&out, 7, 2),
        106,
        "960 / 9 must truncate to 106, not round to 107"
    );
}

#[test]
fn convolve_truncates_a_non_integer_kernel_like_libvips() {
    // Three identical rows (so only the middle kernel row, which is the
    // only one with nonzero weight, matters) of columns 60/70/61 — kernel
    // dimensions must be >= 3 in both axes (see the MIN_KERNEL_DIM tests
    // below), so the "1-D" shape is expressed as a 3x3 kernel with zeroed
    // top/bottom rows rather than a literal 3x1. Window at x=1:
    // 60*0.5 + 70*0 + 61*0.5 = 60.5; the kernel sums to 1.0 so the auto
    // scale is 1.0.
    //
    // Measured on sharp 0.34.5: **60**, not 61. There is no separate
    // rounding path for a non-integer kernel — `vips_conv` is a float
    // convolution whatever the mask looks like, and the only quantisation
    // is the truncating cast at the end of the filter run.
    let row = [60u8, 60, 60, 70, 70, 70, 61, 61, 61];
    let data = row.repeat(3);
    let img = RasterImage::new_rgb(3, 3, data);
    #[rustfmt::skip]
    let kernel = [
        0.0, 0.0, 0.0,
        0.5, 0.0, 0.5,
        0.0, 0.0, 0.0,
    ];
    let out = img.convolve(3, 3, &kernel, 0.0, 0.0).unwrap();
    assert_eq!(at(&out, 1, 1), 60);
}

#[test]
fn convolve_filters_alpha_too() {
    // Three identical rows of three RGBA columns — see the previous test
    // for why a 3x3 shape stands in for a conceptually 1-D case.
    //
    // Colour is premultiplied by alpha before convolving (#3504 task E4 /
    // controller ruling on the E3 re-review), so the centre's colour is NOT
    // a plain (60 + 90 + 120) * 3 / 9 = 90 average of the stored bytes:
    // premultiplying TRUNCATES (task E5 controller ruling (a)) each column
    // to 60*10/255=2 (2.35 truncated), 90*50/255=17 (17.65 truncated, NOT
    // rounded to 18), 120*30/255=14 (14.12 truncated); the box averages
    // those (integer path, truncating) to (2 + 17 + 14) * 3 / 9 = 99 / 9 =
    // 11 exactly; unpremultiplying by the centre's own convolved alpha (30,
    // computed below) truncates 11 * 255 / 30 = 93.5 down to 93 — matching
    // sharp 0.34.5's real output on this fixture (a rounded 94 was this
    // test's value before the truncation fix).
    let row = [
        60u8, 60, 60, 10, // colour 60, alpha 10
        90, 90, 90, 50, // colour 90, alpha 50
        120, 120, 120, 30, // colour 120, alpha 30
    ];
    let data = row.repeat(3);
    let img = RasterImage::new_rgba(3, 3, data);
    let out = img.convolve(3, 3, &[1.0; 9], 0.0, 0.0).unwrap();
    assert_eq!(at(&out, 1, 1), 93);
    // Alpha at the centre is convolved too, not passed through: (10 + 50 +
    // 30) * 3 rows / 9 = 30 — NOT the original centre value of 50. Alpha
    // itself is never premultiplied, only colour, so this is unaffected by
    // the premultiply change above.
    let alpha_at = |x: u32, y: u32| out.data[((y * 3 + x) * 4 + 3) as usize];
    assert_eq!(alpha_at(1, 1), 30);
}

#[test]
fn convolve_resamples_premultiplied_like_blur() {
    // A 3x3 RGBA image: an opaque red pixel at the centre-left, a
    // transparent pixel with stored green next to it, everything else
    // opaque black. A straight-alpha (non-premultiplied) box convolve would
    // average the transparent neighbour's stored green straight into the
    // red pixel's result; premultiplying first (#3504 task E4 / controller
    // ruling on the E3 re-review) scales that stored green by its own zero
    // alpha before averaging, so it contributes exactly 0 regardless of the
    // weights clamp-to-edge assigns — the red pixel's green channel must
    // come back at 0, not some fraction of 255.
    let opaque_black = [0u8, 0, 0, 255];
    let opaque_red = [255u8, 0, 0, 255];
    let transparent_green = [0u8, 255, 0, 0];
    let px = |x: u32, y: u32| -> [u8; 4] {
        match (x, y) {
            (0, 1) => opaque_red,
            (1, 1) => transparent_green,
            _ => opaque_black,
        }
    };
    let data = (0..3u32)
        .flat_map(|y| (0..3u32).flat_map(move |x| px(x, y)))
        .collect();
    let img = RasterImage::new_rgba(3, 3, data);
    let out = img.convolve(3, 3, &[1.0; 9], 9.0, 0.0).unwrap();
    let green_at = |x: u32, y: u32| out.data[((y * 3 + x) * 4 + 1) as usize];
    assert!(
        green_at(0, 1) <= 1,
        "the red pixel's green must stay ~0, got {}",
        green_at(0, 1)
    );
}

#[test]
fn convolve_spreads_an_alpha_hole_like_any_other_band() {
    // A single transparent "hole" (alpha 0) at the centre of an otherwise
    // fully-opaque 5x5 field — the alpha analogue of the colour impulse
    // fixture above, but inverted (a hole in 255 rather than a spike in 0).
    // Measured against sharp 0.34.5 (a real `.convolve` run, alpha band
    // included): every cell within the box's reach sees exactly 8 taps of
    // 255 and 1 tap of 0, `(8*255 + 0) / 9 = 226.67`, truncated to 226 —
    // confirming `convolve` no longer exempts alpha the way the
    // colour-only draft of this function once did.
    let n = 5u32;
    let centre = n / 2;
    let data = (0..n)
        .flat_map(|y| {
            (0..n).flat_map(move |x| {
                let a = if x == centre && y == centre { 0u8 } else { 255 };
                [0u8, 0, 0, a]
            })
        })
        .collect();
    let img = RasterImage::new_rgba(n, n, data);
    let out = img.convolve(3, 3, &[1.0; 9], 9.0, 0.0).unwrap();
    let alpha_at = |x: u32, y: u32| out.data[((y * n + x) * 4 + 3) as usize];
    for y in 1..=3 {
        for x in 1..=3 {
            assert_eq!(alpha_at(x, y), 226, "alpha at ({x},{y}) should be 226");
        }
    }
    assert_eq!(
        alpha_at(0, 0),
        255,
        "outside the hole's spread stays opaque"
    );
}

#[test]
fn convolve_rejects_a_kernel_below_the_3_floor() {
    // sharp's own contract: both dimensions must be >= 3. Named by value.
    let err_1x1 = impulse(5).convolve(1, 1, &[1.0], 1.0, 0.0).unwrap_err();
    assert!(err_1x1.to_string().contains("1x1"));
    let err_2x2 = impulse(5).convolve(2, 2, &[1.0; 4], 1.0, 0.0).unwrap_err();
    assert!(err_2x2.to_string().contains("2x2"));
}

#[test]
fn convolve_accepts_an_even_sized_kernel() {
    // sharp accepts even kernel dimensions (measured: a 4x4 kernel is a
    // valid real input) — only the [3, 1001] floor/ceiling is enforced, not
    // oddness. A flat field is invariant under any normalised box kernel
    // regardless of parity, which is what this pins.
    let flat = RasterImage::new_rgb(6, 6, vec![50; 6 * 6 * 3]);
    let out = flat.convolve(4, 4, &[1.0; 16], 0.0, 0.0).unwrap();
    assert!(out.data.iter().all(|&v| v == 50));
}
