use super::*;
use crate::image::CfaPattern;

fn tiny_raw(raw_data: Vec<u16>, w: u32, h: u32) -> RawImage {
    RawImage {
        width: w,
        height: h,
        cfa: CfaPattern::Rggb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        raw_data,
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

#[test]
fn black_level_maps_to_zero() {
    let raw = tiny_raw(vec![0, 512, 1023, 256], 2, 2);
    let img = sensor_linearize(&raw);
    assert_eq!(img.pixels[0][0], 0.0);
}

#[test]
fn white_level_maps_to_one() {
    let raw = tiny_raw(vec![0, 0, 1023, 0], 2, 2);
    let img = sensor_linearize(&raw);
    // position (0,1) is G for RGGB; the G channel should read 1.0.
    assert_eq!(img.pixels[2][1], 1.0);
}

#[test]
fn value_above_white_clamps_to_one() {
    let raw = tiny_raw(vec![0, 0, 0, 2000], 2, 2);
    let img = sensor_linearize(&raw);
    // position (1,1) is B for RGGB; B channel should clamp to 1.0.
    assert_eq!(img.pixels[3][2], 1.0);
}

#[test]
fn per_position_black_level_applies() {
    let mut raw = tiny_raw(vec![100, 100, 100, 100], 2, 2);
    raw.black_level = [100, 50, 50, 0]; // R, Gr, Gb, B
    let img = sensor_linearize(&raw);
    // R at (0,0): (100 - 100) / (1023 - 100) = 0
    assert_eq!(img.pixels[0][0], 0.0);
    // G at (1,0): (100 - 50) / (1023 - 50) ≈ 0.0514
    assert!((img.pixels[1][1] - 0.0514).abs() < 1e-3);
}

const XTRANS_PATTERN: [u8; 36] = [
    1, 1, 0, 1, 1, 2, //
    1, 1, 2, 1, 1, 0, //
    2, 0, 1, 0, 2, 1, //
    1, 1, 2, 1, 1, 0, //
    1, 1, 0, 1, 1, 2, //
    0, 2, 1, 2, 0, 1, //
];

/// X-Trans `black_level` is `[R, G, B, B]` keyed by CFA colour, not by
/// 2×2 position (#4730): a frame sitting at each colour's own black must
/// linearize to zero at every one of the 36 sites.
#[test]
fn xtrans_black_level_is_indexed_by_cfa_colour() {
    let black_by_colour = [1000u16, 1100, 1200];
    let raw_data: Vec<u16> = XTRANS_PATTERN
        .iter()
        .map(|&c| black_by_colour[c as usize])
        .collect();
    let mut raw = tiny_raw(raw_data, 6, 6);
    raw.cfa = CfaPattern::XTrans(XTRANS_PATTERN);
    raw.black_level = [1000, 1100, 1200, 1200];
    raw.white_level = 4095;
    let img = sensor_linearize(&raw);
    assert!(
        img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]),
        "{:?}",
        img.pixels
    );
}

/// LinearRaw reads blue's black from slot 2, matching the `[R, G, B, B]`
/// layout decode writes (#4730). Slot 3 is deliberately different here so
/// a `[3]` read cannot pass by coincidence.
#[test]
fn linearraw_black_level_reads_blue_from_slot_two() {
    let mut raw = tiny_raw(vec![100, 200, 300], 1, 1);
    raw.cfa = CfaPattern::LinearRgb;
    raw.black_level = [100, 200, 300, 0];
    raw.white_level = 1300;
    let img = linearraw_to_camera_rgb(&raw).expect("1×1 LinearRaw");
    assert_eq!(img.pixels[0], [0.0, 0.0, 0.0]);
}

/// Regression test for #1087 — a zero-dim sensor (or a zero-area
/// region) must produce an empty image, not panic. Pre-fix, a zero
/// rect width reached `par_chunks_mut(0)`, which aborts with
/// "chunk_size must not be zero". `decode_bytes` now rejects such
/// files outright; this covers the hand-built-`RawImage` surface
/// that bypasses decode validation.
#[test]
fn zero_dim_input_linearizes_to_empty_image_without_panicking() {
    // Zero-width sensor through the full-image entry point.
    let raw = tiny_raw(vec![], 0, 4);
    let img = sensor_linearize(&raw);
    assert_eq!((img.width, img.height), (0, 4));
    assert!(img.pixels.is_empty());

    // Zero-width region of an otherwise valid sensor — the rect shape
    // that hit `par_chunks_mut(0)` pre-fix.
    let raw = tiny_raw(vec![0, 512, 1023, 256], 2, 2);
    let img = sensor_linearize_region(&raw, 0, 0, 0, 2);
    assert_eq!((img.width, img.height), (0, 2));
    assert!(img.pixels.is_empty());
}

#[test]
fn output_space_is_camera_native_mosaic() {
    let raw = tiny_raw(vec![0, 0, 0, 0], 2, 2);
    let img = sensor_linearize(&raw);
    assert_eq!(img.space, ColorSpace::CameraNativeMosaic);
}

/// Regression test for ticket #07: a 2×2 LinearRaw image with deliberately
/// distinct R/G/B values per pixel verifies that
/// `linearraw_to_camera_rgb` lays the data into `Image::pixels[k] = [R, G, B]`
/// channel-major. Pre-bug (every-other-column misroute via the Bayer
/// path), the second pixel would pick up neighbor blue samples; this
/// test catches that regression. Uses identity AsShotNeutral so the
/// pre-bake-undo step is a no-op and the test isolates the laydown.
#[test]
fn linearraw_to_camera_rgb_lays_data_channel_major() {
    let raw_data: Vec<u16> = vec![
        // px 0: R=100  G=200  B=300
        100, 200, 300, // px 1: R=400  G=500  B=600
        400, 500, 600, // px 2: R=700  G=800  B=900
        700, 800, 900, // px 3: R=1000 G=1100 B=1200
        1000, 1100, 1200,
    ];
    let raw = RawImage {
        width: 2,
        height: 2,
        cfa: CfaPattern::LinearRgb,
        black_level: [0, 0, 0, 0],
        white_level: 1500,
        raw_data,
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    };
    let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw decode");
    assert_eq!(img.width, 2);
    assert_eq!(img.height, 2);
    assert_eq!(img.space, ColorSpace::CameraNativeLinearRgb);
    // Each pixel's R/G/B are normalized by white_level=1500.
    let n = 1.0 / 1500.0;
    let exp = [
        [100.0 * n, 200.0 * n, 300.0 * n],
        [400.0 * n, 500.0 * n, 600.0 * n],
        [700.0 * n, 800.0 * n, 900.0 * n],
        [1000.0 * n, 1100.0 * n, 1200.0 * n],
    ];
    for k in 0..4 {
        for c in 0..3 {
            let got = img.pixels[k][c];
            let want = exp[k][c];
            assert!(
                (got - want).abs() < 1e-5,
                "pixel {} channel {}: got {}, want {}",
                k,
                c,
                got,
                want
            );
        }
    }
}

/// Regression test for ticket #373: high-bit-depth LinearRaw (Canon
/// sRaw, iPhone LinearRaw) carries camera-RGB data — neutrals read as
/// `(K × asn_r, K, K × asn_b)`, NOT WB-baked `(K, K, K)`. The helper
/// must pass camera-RGB through unmodified (only black-/white-level
/// normalization), so the downstream pre-gain step in
/// `pipeline/develop.rs` can divide by AsShotNeutral and land neutrals
/// at `(1, 1, 1)` into DCP — same shape the Bayer + demosaic pipeline
/// produces.
///
/// Verified empirically by `examples/sraw_probe`: Canon 5D Mark IV
/// sRaw center-patch ratios are `(R/G, B/G) ≈ (0.55, 0.68)` against
/// AsShotNeutral `(0.50, 0.68)` — clearly camera-RGB, not
/// WB-baked `(1.0, 1.0)`.
#[test]
fn linearraw_to_camera_rgb_passes_camera_rgb_through_unchanged() {
    // A camera-RGB neutral patch reads `(K * asn_r, K * asn_g, K * asn_b)`
    // — the same shape the Bayer pipeline produces post-demosaic.
    // The helper should preserve those raw camera readings (post black/
    // white normalization). asn here is typical Canon daylight.
    let asn: [f32; 3] = [0.606276, 1.0, 0.46188504];
    let k = 100u16;
    let raw_data: Vec<u16> = vec![
        (k as f32 * asn[0]).round() as u16,
        (k as f32 * asn[1]).round() as u16,
        (k as f32 * asn[2]).round() as u16,
    ];
    let raw = RawImage {
        width: 1,
        height: 1,
        cfa: CfaPattern::LinearRgb,
        black_level: [0, 0, 0, 0],
        // > 255 so we hit the high-bit-depth branch (not the lossy_8bit gamma path).
        white_level: 1000,
        raw_data: raw_data.clone(),
        as_shot_neutral: asn,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    };
    let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw decode");
    let p = img.pixels[0];
    let denom = (raw.white_level as f32).max(1.0);
    // Expect raw counts normalized only — NO AsShotNeutral multiply.
    let expected = [
        raw_data[0] as f32 / denom,
        raw_data[1] as f32 / denom,
        raw_data[2] as f32 / denom,
    ];
    for c in 0..3 {
        assert!(
            (p[c] - expected[c]).abs() < 1e-3,
            "channel {}: got {}, want {} (raw[{}]={} / white={})",
            c,
            p[c],
            expected[c],
            c,
            raw_data[c],
            raw.white_level
        );
    }
    // R/G ratio of output should be ≈ asn_r (camera-RGB), NOT 1.0.
    let rg = p[0] / p[1];
    let bg = p[2] / p[1];
    assert!(
        (rg - asn[0]).abs() < 1e-2,
        "R/G = {} should be ≈ asn_r = {} (camera-RGB passthrough)",
        rg,
        asn[0]
    );
    assert!(
        (bg - asn[2]).abs() < 1e-2,
        "B/G = {} should be ≈ asn_b = {} (camera-RGB passthrough)",
        bg,
        asn[2]
    );
}

/// Regression test for ticket #07: `linearraw_to_camera_rgb` rejects
/// `raw_data` lengths that aren't 3 × w × h with a clear `Error::Decode`.
#[test]
fn linearraw_to_camera_rgb_rejects_wrong_buffer_length() {
    let raw = RawImage {
        width: 4,
        height: 4,
        cfa: CfaPattern::LinearRgb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        // Length 16 instead of 48 — should error.
        raw_data: vec![0; 16],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    };
    let err = linearraw_to_camera_rgb(&raw).unwrap_err();
    match err {
        crate::Error::Decode { reason, .. } => {
            assert!(
                reason.contains("LinearRaw raw_data length"),
                "unexpected error message: {}",
                reason
            );
        }
        other => panic!("expected Error::Decode, got {:?}", other),
    }
}
