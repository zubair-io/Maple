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
fn median_rejects_an_even_window() {
    assert!(impulse(5).median(2).is_err());
    assert!(impulse(5).median(0).is_err());
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
    let data = (0..8u32)
        .flat_map(|x| [90u8, 90, 90, if x == 4 { 0 } else { 255 }])
        .collect();
    let img = RasterImage::new_rgba(8, 1, data);
    let out = img.median(3).unwrap();
    assert_eq!(
        out.data[4 * 4 + 3],
        255,
        "the lone transparent pixel is a speck"
    );
}

// ------------------------------------------------------------- threshold ---

#[test]
fn threshold_binarises_through_greyscale_by_default() {
    // Rec.709 luma of pure red is 54, which is below 128 -> black.
    let img = RasterImage::new_rgb(2, 1, vec![255, 0, 0, 0, 255, 0]);
    let out = img.threshold(128, true);
    assert_eq!(&out.data[..3], &[0, 0, 0]);
    // Luma of pure green is 182, above 128 -> white.
    assert_eq!(&out.data[3..], &[255, 255, 255]);
}

#[test]
fn threshold_without_greyscale_binarises_each_channel() {
    let img = RasterImage::new_rgb(1, 1, vec![255, 0, 130]);
    assert_eq!(img.threshold(128, false).data, vec![255, 0, 255]);
}

#[test]
fn threshold_closed_form_100_200_pair() {
    // A neutral grey pair (equal r/g/b, so greyscale's weighted luma and a
    // plain per-channel comparison agree): 100 < 128 -> 0, 200 >= 128 -> 255.
    let img = RasterImage::new_rgb(2, 1, vec![100, 100, 100, 200, 200, 200]);
    assert_eq!(img.threshold(128, true).data, vec![0, 0, 0, 255, 255, 255]);
}

#[test]
fn threshold_leaves_alpha_alone() {
    let img = RasterImage::new_rgba(1, 1, vec![255, 255, 255, 64]);
    assert_eq!(img.threshold(128, true).data[3], 64);
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
fn convolve_rounds_a_non_integer_kernel() {
    // A non-integer kernel takes the float path (rounds instead of
    // truncating). Window at x=1: 60*0.5 + 70*0 + 61*0.5 = 60.5; the kernel
    // sums to 1.0 so the auto scale is 1.0; round(60.5) = 61 under Rust's
    // f64::round (half away from zero) — truncation would give 60.
    let img = RasterImage::new_rgb(3, 1, vec![60, 60, 60, 70, 70, 70, 61, 61, 61]);
    let out = img.convolve(3, 1, &[0.5, 0.0, 0.5], 0.0, 0.0).unwrap();
    assert_eq!(at(&out, 1, 0), 61);
}

#[test]
fn convolve_leaves_alpha_untouched() {
    let img = RasterImage::new_rgba(
        3,
        1,
        vec![60, 60, 60, 10, 90, 90, 90, 20, 120, 120, 120, 30],
    );
    let out = img.convolve(3, 1, &[1.0, 1.0, 1.0], 0.0, 0.0).unwrap();
    // Colour: (60 + 90 + 120) / 3 = 90.
    assert_eq!(at(&out, 1, 0), 90);
    // Alpha at x=1 is untouched, not averaged with its neighbours (10, 30).
    assert_eq!(out.data[1 * 4 + 3], 20);
}
