use super::*;

/// A single white pixel at the centre of a black `n`x`n` field.
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

fn at(img: &RasterImage, x: u32, y: u32) -> u8 {
    img.data[((y * img.width + x) * img.channels as u32) as usize]
}

#[test]
fn blur_spreads_an_impulse_symmetrically() {
    let out = impulse(9).blur(Some(1.5)).unwrap();
    assert_eq!((out.width, out.height), (9, 9));
    assert!(at(&out, 4, 4) < 255, "the peak must fall");
    assert!(at(&out, 4, 4) > 0);
    // Symmetry in both axes is the strongest evidence the separable pass
    // is wired the right way round.
    assert_eq!(at(&out, 3, 4), at(&out, 5, 4));
    assert_eq!(at(&out, 4, 3), at(&out, 4, 5));
    assert_eq!(at(&out, 3, 4), at(&out, 4, 3));
}

#[test]
fn blur_conserves_total_energy() {
    let out = impulse(9).blur(Some(1.5)).unwrap();
    let total: u32 = out.data.iter().step_by(3).map(|&v| v as u32).sum();
    // Radius 3 (libvips' amplitude cutoff at sigma 1.5) loses
    // essentially nothing to boundary clamping — see `gaussian_kernel`'s
    // doc comment — so this budget is tight: only ordinary `u8`
    // rounding bias, not truncated mass, should show up here.
    assert!(
        (253..=257).contains(&total),
        "a near-lossless kernel should conserve the 255 it started with, got {total}"
    );
}

#[test]
fn kernel_radius_matches_libvips_amplitude_cutoff() {
    assert_eq!(kernel_radius(1.5), 3);
    assert_eq!(kernel_radius(0.3), 1);
    assert_eq!(kernel_radius(5.0), 9);
}

#[test]
fn blur_with_no_sigma_is_the_3x3_box() {
    // sharp: "performs a fast 3x3 box blur". 255/9 = 28.33 -> 28.
    let out = impulse(5).blur(None).unwrap();
    assert_eq!(at(&out, 2, 2), 28);
    assert_eq!(at(&out, 1, 1), 28);
    assert_eq!(at(&out, 0, 0), 0, "the box has a radius of one");
}

#[test]
fn blur_leaves_a_flat_field_flat() {
    let flat = RasterImage::new_rgb(8, 8, vec![77; 8 * 8 * 3]);
    let out = flat.blur(Some(3.0)).unwrap();
    assert!(
        out.data.iter().all(|&v| v == 77),
        "clamp-to-edge must not darken the border"
    );
}

#[test]
fn blur_filters_the_alpha_channel_too() {
    // Half opaque, half transparent — blurring must produce a gradient in
    // the alpha channel, which is how libvips' gaussblur behaves.
    let data = (0..1u32)
        .flat_map(|_| (0..8u32).flat_map(|x| [200u8, 200, 200, if x < 4 { 255 } else { 0 }]))
        .collect();
    let img = RasterImage::new_rgba(8, 1, data);
    let out = img.blur(Some(1.5)).unwrap();
    assert!(
        out.data[4 * 4 + 3] < 255 && out.data[4 * 4 + 3] > 0,
        "alpha did not blur"
    );
}

#[test]
fn an_out_of_range_sigma_is_rejected() {
    assert!(impulse(5).blur(Some(0.0)).is_err());
    assert!(impulse(5).blur(Some(2000.0)).is_err());
}

#[test]
fn a_nan_sigma_is_rejected_by_name() {
    let err = impulse(5).blur(Some(f64::NAN)).unwrap_err();
    assert!(
        err.to_string().contains("NaN"),
        "expected the error to name NaN, got: {err}"
    );
}

#[test]
fn convolve_separable_with_colour_only_leaves_alpha_byte_identical() {
    // sharpen (#3504) calls `convolve_separable(.., colour_only: true)`
    // and must not touch alpha at all — pin that directly against the
    // shared helper rather than only through `blur`, which always
    // convolves alpha (`colour_only: false`).
    let data: Vec<u8> = (0..4u32)
        .flat_map(|x| [10u8 * x as u8, 20, 30, 40 + x as u8])
        .collect();
    let src = RasterImage::new_rgba(4, 1, data.clone());
    let kernel = vec![1.0 / 3.0; 3];
    let out = convolve_separable(&src, &kernel, true);

    let alpha_before: Vec<u8> = data.chunks_exact(4).map(|px| px[3]).collect();
    let alpha_after: Vec<u8> = out.data.chunks_exact(4).map(|px| px[3]).collect();
    assert_eq!(
        alpha_after, alpha_before,
        "colour_only must not touch alpha"
    );

    let colour_before: Vec<u8> = data
        .chunks_exact(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect();
    let colour_after: Vec<u8> = out
        .data
        .chunks_exact(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect();
    assert_ne!(
        colour_before, colour_after,
        "the box kernel should still change colour"
    );
}

#[test]
fn blur_zeroes_colour_where_alpha_stays_fully_transparent() {
    // A 255-alpha impulse on a fully-transparent field: far from the
    // impulse, alpha must stay 0 (the kernel's support is local), and
    // colour there must be exactly 0 rather than some divided-back-out
    // remainder of the unpremultiply.
    let n = 9u32;
    let centre = n / 2;
    let data = (0..n)
        .flat_map(|y| {
            (0..n).flat_map(move |x| {
                if x == centre && y == centre {
                    [255u8, 255, 255, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
        })
        .collect();
    let img = RasterImage::new_rgba(n, n, data);
    let out = img.blur(Some(0.5)).unwrap();
    assert_eq!(at(&out, 0, 0), 0);
    let corner_alpha = out.data[((0 * n + 0) * 4 + 3) as usize];
    assert_eq!(
        corner_alpha, 0,
        "a small sigma must not spread alpha to the far corner"
    );
}
