use super::*;
use crate::raster_filter_conv::gaussmat_radius;

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

/// The red channel of one row, which is enough to pin a symmetric blur.
fn row(img: &RasterImage, y: u32) -> Vec<u8> {
    (0..img.width).map(|x| at(img, x, y)).collect()
}

#[test]
fn blur_spreads_an_impulse_exactly_as_sharp_does() {
    // Measured on sharp 0.34.5: a 9x9 white-centre impulse blurred at sigma
    // 1.5 gives this centre row byte for byte. The mask is libvips' integer
    // Gaussian [8, 16, 20, 16, 8] / 68 run as two byte passes, and the
    // reach is 2 taps — the 3-tap reach this file used before #3504's final
    // wave put a non-zero value at x=1 and x=7, where sharp has none.
    let out = impulse(9).blur(Some(1.5)).unwrap();
    assert_eq!((out.width, out.height), (9, 9));
    assert_eq!(row(&out, 4), vec![0, 0, 9, 18, 23, 18, 9, 0, 0]);
    // Symmetry in both axes is the strongest evidence the separable pass is
    // wired the right way round.
    assert_eq!(at(&out, 4, 3), at(&out, 4, 5));
    assert_eq!(at(&out, 3, 4), at(&out, 4, 3));
    // sharp's own total over the red channel, for the record: two integer
    // passes at this mask gain a little rather than conserving the 255 the
    // impulse started with.
    let total: u32 = out.data.iter().step_by(3).map(|&v| v as u32).sum();
    assert_eq!(total, 259);
}

#[test]
fn blur_mask_radius_matches_libvips_amplitude_cutoff() {
    // libvips keeps every tap whose amplitude is still at or above
    // `min_ampl` (0.2 for `blur`) and drops the rest, which is
    // `floor(sigma * sqrt(-2 * ln 0.2))` = `floor(sigma * 1.7941)`.
    // Measured against sharp 0.34.5 over 15 sigmas from 0.3 to 8.5: the
    // reach matches that expression every time, and it is legitimately 0.
    assert_eq!(gaussmat_radius(1.5, BLUR_MIN_AMPL), 2);
    assert_eq!(gaussmat_radius(0.3, BLUR_MIN_AMPL), 0);
    assert_eq!(gaussmat_radius(5.0, BLUR_MIN_AMPL), 8);
}

#[test]
fn a_small_sigma_blur_is_an_exact_identity() {
    // A 1x1 mask is what the amplitude cutoff leaves for every sigma up to
    // 0.557, and sharp's `blur(0.5)` really is a no-op: measured
    // byte-identical on 32x32 noise and on this impulse.
    let src = impulse(5);
    for sigma in [0.3, 0.5, 0.557] {
        assert_eq!(
            src.blur(Some(sigma)).unwrap().data,
            src.data,
            "sigma {sigma}"
        );
    }
}

#[test]
fn blur_with_no_sigma_is_the_3x3_box() {
    // sharp: "performs a fast 3x3 box blur", and `vips_conv` at its default
    // float precision leaves the truncation to the final cast:
    // 255/9 = 28.33 -> 28, never 29.
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
fn blur_filters_alpha_and_premultiplies_colour_like_sharp() {
    // 8x1, left half opaque grey, right half fully transparent. Measured on
    // sharp 0.34.5 at sigma 1.5: alpha ramps 255, 255, 225, 165, 90, 30, 0,
    // 0 and the colour stays at (or just under) 200 through the ramp rather
    // than being dragged toward the transparent side's stored black — the
    // premultiply-once-per-run behaviour this file relies on.
    let data = (0..8u32)
        .flat_map(|x| [200u8, 200, 200, if x < 4 { 255 } else { 0 }])
        .collect();
    let out = RasterImage::new_rgba(8, 1, data).blur(Some(1.5)).unwrap();
    let alpha: Vec<u8> = out.data.chunks_exact(4).map(|px| px[3]).collect();
    assert_eq!(alpha, vec![255, 255, 225, 165, 90, 30, 0, 0]);
    assert_eq!(row(&out, 0), vec![200, 200, 200, 200, 198, 195, 0, 0]);
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
fn blur_zeroes_colour_where_alpha_stays_fully_transparent() {
    // A 255-alpha white impulse on a fully-transparent black field. Measured
    // on sharp 0.34.5 at sigma 1.5: inside the mask's support the
    // unpremultiply divides the colour straight back out to 255 even where
    // alpha is only 9, and outside it both colour and alpha are exactly 0 —
    // no divided-back-out remainder.
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
    let out = RasterImage::new_rgba(n, n, data).blur(Some(1.5)).unwrap();
    let centre_row: Vec<[u8; 4]> = out.data[(4 * n * 4) as usize..(5 * n * 4) as usize]
        .chunks_exact(4)
        .map(|px| [px[0], px[1], px[2], px[3]])
        .collect();
    assert_eq!(
        centre_row,
        vec![
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [255, 255, 255, 9],
            [255, 255, 255, 18],
            [255, 255, 255, 23],
            [255, 255, 255, 18],
            [255, 255, 255, 9],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ]
    );
    assert_eq!(&out.data[..4], &[0, 0, 0, 0], "the far corner stays empty");
}
