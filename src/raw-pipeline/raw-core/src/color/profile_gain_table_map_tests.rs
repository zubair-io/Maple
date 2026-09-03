//! Unit tests for [`super`] — split out of `profile_gain_table_map.rs`
//! to keep that file under the 570-line headroom gate.

use super::*;
use crate::image::ColorSpace;

/// Build a synthetic well-formed PGTM blob (64-byte header) in big-endian
/// (matches Apple DNG byte order). `gains.len()` must be `v * h * n`.
#[allow(clippy::too_many_arguments)]
fn make_blob_be(
    v: u32,
    h: u32,
    n: u32,
    spacing_v: f64,
    spacing_h: f64,
    origin_v: f64,
    origin_h: f64,
    weights: [f32; 5],
    gains: &[f32],
) -> Vec<u8> {
    assert_eq!(gains.len(), (v * h * n) as usize);
    let mut out = Vec::with_capacity(64 + gains.len() * 4);
    out.extend_from_slice(&v.to_be_bytes());
    out.extend_from_slice(&h.to_be_bytes());
    out.extend_from_slice(&spacing_v.to_be_bytes());
    out.extend_from_slice(&spacing_h.to_be_bytes());
    out.extend_from_slice(&origin_v.to_be_bytes());
    out.extend_from_slice(&origin_h.to_be_bytes());
    out.extend_from_slice(&n.to_be_bytes());
    for w in weights {
        out.extend_from_slice(&w.to_be_bytes());
    }
    for g in gains {
        out.extend_from_slice(&g.to_be_bytes());
    }
    assert_eq!(out.len(), 64 + gains.len() * 4);
    out
}

/// A pure-spatial (N=1) uniform map covering [0,1]×[0,1], all gains equal.
fn uniform_spatial(v: u32, h: u32, gain: f32) -> Vec<u8> {
    make_blob_be(
        v,
        h,
        1,
        1.0,
        1.0,
        0.0,
        0.0,
        [0.0; 5],
        &vec![gain; (v * h) as usize],
    )
}

#[test]
fn from_bytes_parses_64_byte_header_and_n_axis() {
    // 2×3 spatial × N=2, spacing/origin/weights all read back.
    let gains: Vec<f32> = (0..(2 * 3 * 2)).map(|i| 1.0 + i as f32 * 0.1).collect();
    let bytes = make_blob_be(
        2,
        3,
        2,
        0.5,
        0.25,
        0.1,
        0.2,
        [0.2, 0.3, 0.1, 0.15, 0.25],
        &gains,
    );
    let map = ProfileGainTableMap::from_bytes(&bytes, false /* big-endian */)
        .expect("PGTM with 64-byte header parses");
    assert_eq!(map.map_points_v, 2);
    assert_eq!(map.map_points_h, 3);
    assert_eq!(map.map_points_n, 2);
    assert!((map.spacing_v - 0.5).abs() < 1e-6);
    assert!((map.spacing_h - 0.25).abs() < 1e-6);
    assert!((map.origin_v - 0.1).abs() < 1e-6);
    assert!((map.origin_h - 0.2).abs() < 1e-6);
    assert!((map.input_weights[0] - 0.2).abs() < 1e-6);
    assert!((map.input_weights[4] - 0.25).abs() < 1e-6);
    assert_eq!(map.gains.len(), 2 * 3 * 2);
}

#[test]
fn from_bytes_accepts_real_proraw_large_n() {
    // The #1923 regression: a real Apple ProRAW PGTM has a large
    // MapPointsN (e.g. 257) that the retired parser mis-read as an invalid
    // MapPlanes and rejected. With the correct 64-byte header + N-axis
    // layout it must now parse rather than silently bail to None.
    let (v, h, n) = (2u32, 2u32, 257u32);
    let gains = vec![1.0f32; (v * h * n) as usize];
    let bytes = make_blob_be(
        v,
        h,
        n,
        1.0,
        1.0,
        0.0,
        0.0,
        [0.0, 0.0, 0.0, 0.0, 1.0],
        &gains,
    );
    let map = ProfileGainTableMap::from_bytes(&bytes, false)
        .expect("large-N Apple ProRAW PGTM must parse (#1923)");
    assert_eq!(map.map_points_n, 257);
    assert_eq!(map.gains.len(), (v * h * n) as usize);
}

#[test]
fn from_bytes_rejects_short_blob() {
    assert!(ProfileGainTableMap::from_bytes(&vec![0u8; 30], false).is_none());
    // 63 bytes — one short of the 64-byte header.
    assert!(ProfileGainTableMap::from_bytes(&vec![0u8; 63], false).is_none());
}

#[test]
fn from_bytes_rejects_zero_dims() {
    for (v, h, n) in [(0u32, 3u32, 1u32), (3, 0, 1), (3, 3, 0)] {
        let mut bytes = vec![0u8; 64];
        bytes[0..4].copy_from_slice(&v.to_be_bytes());
        bytes[4..8].copy_from_slice(&h.to_be_bytes());
        bytes[40..44].copy_from_slice(&n.to_be_bytes());
        assert!(
            ProfileGainTableMap::from_bytes(&bytes, false).is_none(),
            "V={v} H={h} N={n} must be rejected"
        );
    }
}

#[test]
fn from_bytes_rejects_length_mismatch() {
    // Header says 3×3×1 = 9 floats (36 bytes) but only 8 supplied.
    let mut bytes = vec![0u8; 64 + 8 * 4];
    bytes[0..4].copy_from_slice(&3_u32.to_be_bytes());
    bytes[4..8].copy_from_slice(&3_u32.to_be_bytes());
    bytes[40..44].copy_from_slice(&1_u32.to_be_bytes());
    assert!(ProfileGainTableMap::from_bytes(&bytes, false).is_none());
}

#[test]
fn gain_at_spatial_bilinear_n1() {
    // 2×2 lattice, N=1, corners 1,2,3,4 over [0,1]×[0,1].
    let bytes = make_blob_be(2, 2, 1, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 2.0, 3.0, 4.0]);
    let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
    assert!((map.gain_at(0.0, 0.0, 0.0) - 1.0).abs() < 1e-5);
    assert!((map.gain_at(1.0, 1.0, 0.0) - 4.0).abs() < 1e-5);
    assert!((map.gain_at(0.5, 0.5, 0.0) - 2.5).abs() < 1e-5);
}

#[test]
fn gain_at_value_axis_interpolates_linearly() {
    // 1×1 spatial × N=2: value axis spans gains 1.0 → 3.0.
    let bytes = make_blob_be(1, 1, 2, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 3.0]);
    let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
    assert!((map.gain_at(0.5, 0.5, 0.0) - 1.0).abs() < 1e-5);
    assert!((map.gain_at(0.5, 0.5, 1.0) - 3.0).abs() < 1e-5);
    assert!((map.gain_at(0.5, 0.5, 0.5) - 2.0).abs() < 1e-5);
    // Out-of-range t clamps.
    assert!((map.gain_at(0.5, 0.5, -1.0) - 1.0).abs() < 1e-5);
    assert!((map.gain_at(0.5, 0.5, 2.0) - 3.0).abs() < 1e-5);
}

#[test]
fn apply_uniform_spatial_map_scales_all_pixels() {
    let map = ProfileGainTableMap::from_bytes(&uniform_spatial(2, 2, 2.0), false).unwrap();
    let mut img = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
    for p in img.pixels.iter_mut() {
        *p = [0.3, 0.4, 0.5];
    }
    apply(&mut img, &map);
    for p in &img.pixels {
        assert!((p[0] - 0.6).abs() < 1e-4, "got {}", p[0]);
        assert!((p[1] - 0.8).abs() < 1e-4);
        assert!((p[2] - 1.0).abs() < 1e-4);
    }
}

#[test]
fn apply_uses_half_pixel_centered_coords() {
    // A horizontal gain ramp: 2 lattice cols over [0,1], gains 1.0 → 3.0
    // (V=1 so no vertical variation). N=1. A 2-px-wide image samples the
    // map at u = 0.25 and u = 0.75 (half-pixel centers), so the two pixels
    // get gains 1.5 and 2.5 — NOT 1.0 and 3.0 (which the old x/(w-1)
    // edge-to-edge mapping would have produced).
    let bytes = make_blob_be(1, 2, 1, 1.0, 1.0, 0.0, 0.0, [0.0; 5], &[1.0, 3.0]);
    let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
    let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [1.0, 1.0, 1.0];
    img.pixels[1] = [1.0, 1.0, 1.0];
    apply(&mut img, &map);
    assert!(
        (img.pixels[0][0] - 1.5).abs() < 1e-4,
        "left {}",
        img.pixels[0][0]
    );
    assert!(
        (img.pixels[1][0] - 2.5).abs() < 1e-4,
        "right {}",
        img.pixels[1][0]
    );
}

#[test]
fn apply_value_axis_gain_increases_with_pixel_brightness() {
    // 1×1 spatial × N=2, gains 1.0 → 3.0, value input = max channel
    // (weights [0,0,0,0,1]). A brighter neutral pixel indexes higher on the
    // N axis, so its effective gain multiplier is strictly larger. Neutral
    // pixels stay ~neutral through the Rec.2020→ProPhoto rotation, so the
    // ordering is robust. Compare per-pixel output/input ratios.
    let bytes = make_blob_be(
        1,
        1,
        2,
        1.0,
        1.0,
        0.0,
        0.0,
        [0.0, 0.0, 0.0, 0.0, 1.0],
        &[1.0, 3.0],
    );
    let map = ProfileGainTableMap::from_bytes(&bytes, false).unwrap();
    let mut img = Image::new(1, 2, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.3, 0.3, 0.3];
    img.pixels[1] = [0.7, 0.7, 0.7];
    apply(&mut img, &map);
    let ratio_dark = img.pixels[0][0] / 0.3;
    let ratio_bright = img.pixels[1][0] / 0.7;
    assert!(
        ratio_bright > ratio_dark + 0.2,
        "brighter pixel must index a higher value-axis gain: \
         dark ratio {ratio_dark}, bright ratio {ratio_bright}"
    );
    // Both gains stay within the [1, 3] table range.
    assert!((1.0..=3.0).contains(&ratio_dark) && (1.0..=3.0).contains(&ratio_bright));
}

#[test]
fn apply_little_endian_blob_parses_and_scales() {
    // Same uniform 2× map, little-endian byte order.
    let v = 2u32;
    let h = 2u32;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&v.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&1.0_f64.to_le_bytes());
    bytes.extend_from_slice(&1.0_f64.to_le_bytes());
    bytes.extend_from_slice(&0.0_f64.to_le_bytes());
    bytes.extend_from_slice(&0.0_f64.to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes()); // N
    for _ in 0..5 {
        bytes.extend_from_slice(&0.0_f32.to_le_bytes());
    }
    for _ in 0..(v * h) {
        bytes.extend_from_slice(&2.0_f32.to_le_bytes());
    }
    let map = ProfileGainTableMap::from_bytes(&bytes, true).unwrap();
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in img.pixels.iter_mut() {
        *p = [0.25, 0.25, 0.25];
    }
    apply(&mut img, &map);
    for p in &img.pixels {
        assert!((p[0] - 0.5).abs() < 1e-4);
    }
}
