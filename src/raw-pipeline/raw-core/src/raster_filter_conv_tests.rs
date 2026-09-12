use super::*;
use crate::raster::RasterImage;

/// `blur`'s cutoff (`vips_gaussblur`, and sharp's `minAmpl` default).
const BLUR: f64 = 0.2;
/// `sharpen`'s cutoff (`vips_sharpen` hard-codes it).
const SHARPEN: f64 = 0.1;

#[test]
fn the_two_cutoffs_give_two_different_mask_sizes() {
    // `floor(sigma * 1.7941)` against `floor(sigma * 2.1460)`. Measured
    // reaches on sharp 0.34.5 agree with both: `blur` at sigma 1.5 / 3 / 10
    // reaches 2 / 5 / 17, and `sharpen` at sigma 1.2 / 1.7 / 2.5 / 4.2
    // reaches 2 / 3 / 5 / 9.
    assert_eq!(
        [1.5, 3.0, 10.0].map(|s| gaussmat_radius(s, BLUR)),
        [2, 5, 17]
    );
    assert_eq!(
        [1.2, 1.7, 2.5, 4.2].map(|s| gaussmat_radius(s, SHARPEN)),
        [2, 3, 5, 9]
    );
    // And zero is a real answer: sharp's whole legal band 0.3 … 0.557 is a
    // 1x1 mask, i.e. an identity.
    assert_eq!(
        [0.3, 0.5, 0.557].map(|s| gaussmat_radius(s, BLUR)),
        [0, 0, 0]
    );
}

#[test]
fn the_integer_mask_is_scaled_to_a_peak_of_twenty() {
    assert_eq!(gaussmat_int(1.5, BLUR), (vec![8, 16, 20, 16, 8], 68));
    assert_eq!(gaussmat_int(0.6, BLUR), (vec![5, 20, 5], 30));
    assert_eq!(gaussmat_int(0.5, BLUR), (vec![20], 20));
}

#[test]
fn a_one_tap_mask_is_an_exact_identity() {
    let src: Vec<u8> = (0..12).map(|v| v * 17).collect();
    assert_eq!(convsep_u8(&src, 4, 1, 3, &[20], 20), src);
}

#[test]
fn sigma_0_6_falls_back_to_the_scalar_path() {
    // The one sigma in 0.3 … 6.2 (0.1 steps) whose mask fails libvips'
    // intize accuracy gate, because `Σ 128·tap/scale` lands on
    // 127.99999999999999 and libvips truncates it to an `int`. The vector
    // path's mantissas for this mask sum to 65 rather than 64, a gain of
    // 65/64 that turns a flat 200 field into 206 — sharp 0.34.5 leaves it
    // at exactly 200, which only the scalar path reproduces.
    let (mask, scale) = gaussmat_int(0.6, BLUR);
    let flat = vec![200u8; 8 * 8 * 3];
    assert!(convsep_u8(&flat, 8, 8, 3, &mask, scale)
        .iter()
        .all(|&v| v == 200));
}

#[test]
fn the_float_conv_leaves_truncation_to_the_caller() {
    // `conv_f64` hands back the unrounded quotient; it is the filter
    // chain's single cast that turns one into a byte. On a 1x1 image
    // clamp-to-edge fills all nine taps with the same pixel, so a box comes
    // straight back; on a 3x1 `[255, 0, 0]` the window at x=0 is
    // 3 * (255 + 255 + 0) = 1530, i.e. 170 exactly.
    let out = conv_f64(&[255.0], 1, 1, 1, 3, 3, &[1.0; 9], 9.0, 0.0);
    assert!(
        (out[0] - 255.0).abs() < 1e-9,
        "clamp-to-edge fills the window"
    );
    let out = conv_f64(&[255.0, 0.0, 0.0], 3, 1, 1, 3, 3, &[1.0; 9], 9.0, 0.0);
    assert!((out[0] - 170.0).abs() < 1e-9, "got {}", out[0]);
    // …and an odd quotient stays fractional rather than being rounded here.
    let out = conv_f64(&[60.0, 70.0, 61.0], 3, 1, 1, 3, 3, &[1.0; 9], 9.0, 0.0);
    assert!((out[1] - 191.0 / 3.0).abs() < 1e-9, "got {}", out[1]);
}

#[test]
fn a_flat_field_survives_every_sigma_a_caller_can_ask_for() {
    // Both integer paths preserve a flat field; a mask whose gain drifted
    // would show up here first.
    let flat = RasterImage::new_rgb(8, 8, vec![123; 8 * 8 * 3]);
    for sigma in [0.3, 0.6, 1.0, 1.5, 3.0, 10.0, 50.0] {
        let out = flat.blur(Some(sigma)).unwrap();
        assert!(
            out.data.iter().all(|&v| v == 123),
            "sigma {sigma} did not preserve a flat field"
        );
    }
}
