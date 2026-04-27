use crate::image::{CfaPattern, ColorSpace, Image, RawImage};
use rayon::prelude::*;

/// Sensor linearization per spec § 3.2.
/// `linear = (raw - black) / (white - black)` clamped to [0, 1].
/// Produces a three-channel `Image` where only the CFA-appropriate channel is
/// populated per pixel; the other two are zero. (Demosaic fills them in.)
///
/// **Must NOT be called on `CfaPattern::LinearRgb` data** — that variant has
/// already-demosaiced interleaved RGB, not a Bayer mosaic, and `raw_data` is
/// `3 × w × h` instead of `w × h`. Use [`linearraw_to_camera_rgb`] instead.
pub fn sensor_linearize(raw: &RawImage) -> Image {
    sensor_linearize_region(raw, 0, 0, raw.width, raw.height)
}

/// Linearize a single rectangular region of the sensor. Output is an
/// `Image` of size `(rect_w, rect_h)` — only the requested rect is
/// processed, not the full sensor. Used by the tile path so a 100 MP
/// RAW doesn't pay the full ~480 ms of linearize work per visible tile;
/// instead each tile linearizes its ~512×512-region (with overlap) in
/// a few ms.
///
/// `rect_x` and `rect_y` MUST be even-aligned for Bayer-phase
/// preservation (the caller is `pad_and_clamp_mosaic_rect`, which
/// rounds the start corners down to even). The CFA pattern indexing
/// uses absolute sensor coords so the returned mosaic carries the
/// correct color-at-position assignments.
pub fn sensor_linearize_region(
    raw: &RawImage,
    rect_x: u32, rect_y: u32, rect_w: u32, rect_h: u32,
) -> Image {
    debug_assert_ne!(raw.cfa, CfaPattern::LinearRgb,
        "sensor_linearize must not be called on LinearRgb data; \
         use linearraw_to_camera_rgb instead. See ticket #07.");
    debug_assert!(rect_x + rect_w <= raw.width && rect_y + rect_h <= raw.height,
        "rect ({},{},{},{}) out of bounds for sensor ({},{})",
        rect_x, rect_y, rect_w, rect_h, raw.width, raw.height);

    let sensor_w = raw.width as usize;
    let rw = rect_w as usize;
    let mut img = Image::new(rect_w, rect_h, ColorSpace::CameraNativeMosaic);

    let wl = raw.white_level as f32;
    img.pixels
        .par_chunks_mut(rw)
        .enumerate()
        .for_each(|(local_y, row)| {
            let abs_y = rect_y as usize + local_y;
            let raw_row = &raw.raw_data[abs_y * sensor_w..(abs_y + 1) * sensor_w];
            for (local_x, px) in row.iter_mut().enumerate() {
                let abs_x = rect_x as usize + local_x;
                // Per-CFA-position black level: index as 2*(y&1) + (x&1)
                // in absolute sensor coords (CFA pattern is absolute).
                let bl_idx = ((abs_y & 1) << 1) | (abs_x & 1);
                let bl = raw.black_level[bl_idx] as f32;
                let denom = (wl - bl).max(1.0);
                let raw_v = raw_row[abs_x] as f32;
                let v = ((raw_v - bl) / denom).clamp(0.0, 1.0);
                let color = raw.cfa.color_at(abs_x as u32, abs_y as u32) as usize;
                px[color] = v;
            }
        });
    img
}

/// LinearRaw decode entry. Reshape interleaved `[R₀ G₀ B₀ R₁ G₁ B₁ …]`
/// `raw.raw_data` into a `CameraNativeLinearRgb` `Image`, normalizing
/// per-channel by `(white_level - black_level)` and (for 8-bit lossy
/// LinearRaw) undoing Adobe's implicit gamma encoding.
///
/// **Two flavors of LinearRaw exist in the wild:**
///
/// 1. **8-bit lossy linear DNG** (e.g. `Compression = LossyJPEG`,
///    `BitsPerSample = 8 8 8`, no `LinearizationTable`): Adobe DNG
///    Converter writes the data with WB pre-applied AND with a
///    perceptually-uniform gamma curve (close to 2.4) before JPEG
///    compression to better allocate JPEG's 8-bit dynamic range. We
///    detect this with `white_level <= 255` and invert the gamma:
///    `linear = encoded^2.4`. The data is also WB-baked, so a neutral
///    patch reads `(K, K, K)` after gamma decode — we leave WB alone
///    and the DCP path handles the "neutrals = (1,1,1)" case via
///    `wb_already_baked` (no, kept disabled — see comment below).
///
/// 2. **High-bit-depth linear DNG** (e.g. `BitsPerSample = 12 12 12` +
///    `LinearizationTable`): rawler's `apply_linearization` already
///    converts to 16-bit linear during decode. The data here is genuinely
///    linear and WB-pre-baked. We multiply each channel by AsShotNeutral
///    to undo the WB pre-bake, putting the data in the same camera-RGB
///    space the Bayer pipeline produces. `dcp::apply` then handles it
///    identically.
///
/// Skips both `sensor_linearize` (1 SPP scanline) and `demosaic::*`
/// because the data is already 3-channel RGB. Caller dispatches based on
/// `raw.cfa == CfaPattern::LinearRgb`. See ticket #07.
pub fn linearraw_to_camera_rgb(raw: &RawImage) -> crate::Result<Image> {
    debug_assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    let w = raw.width as usize;
    let h = raw.height as usize;
    let expected = 3 * w * h;
    if raw.raw_data.len() != expected {
        return Err(crate::Error::Decode {
            path: std::path::PathBuf::from("<linearraw>"),
            reason: format!(
                "LinearRaw raw_data length {} != 3 × {} × {} = {} (expected interleaved RGB)",
                raw.raw_data.len(), w, h, expected
            ),
        });
    }
    let wl = raw.white_level as f32;
    // For LinearRaw, black levels per the investigation are typically
    // 0/0/0 — but we honor metadata: index 0 = R, 1 = G, 2 = B
    // (the 4th slot is unused, mirrors RGGB's [R, Gr, Gb, B]).
    let bl_r = raw.black_level[0] as f32;
    let bl_g = raw.black_level[1] as f32;
    let bl_b = raw.black_level[3] as f32;
    let denom_r = (wl - bl_r).max(1.0);
    let denom_g = (wl - bl_g).max(1.0);
    let denom_b = (wl - bl_b).max(1.0);

    let asn_r = raw.as_shot_neutral[0];
    let asn_g = raw.as_shot_neutral[1];
    let asn_b = raw.as_shot_neutral[2];

    // Distinguish 8-bit lossy (gamma-encoded) from high-bit-depth (linear).
    // 8-bit white_level == 255 is the unambiguous signal: any Adobe lossy
    // linear DNG without a LinearizationTable lands here. High-bit-depth
    // lossy DNGs go through rawler's `apply_linearization` and arrive
    // already linearized at white_level = 65535 (or similar).
    let lossy_8bit = raw.white_level <= 255;

    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
    img.pixels.par_iter_mut().enumerate().for_each(|(idx, px)| {
        let off = idx * 3;
        let r_norm = ((raw.raw_data[off    ] as f32 - bl_r) / denom_r).clamp(0.0, 1.0);
        let g_norm = ((raw.raw_data[off + 1] as f32 - bl_g) / denom_g).clamp(0.0, 1.0);
        let b_norm = ((raw.raw_data[off + 2] as f32 - bl_b) / denom_b).clamp(0.0, 1.0);
        let (r, g, b) = if lossy_8bit {
            // 8-bit lossy linear DNG: invert Adobe's gamma 2.4 encoding.
            // WB stays baked; DCP profile derives `scene_white_xyz` from
            // `inv(CM) · AsShotNeutral` (legacy path) — empirically this
            // reaches mean ΔE ≈ 10 vs. the Bayer reference's ΔE ≈ 9.5,
            // i.e. structural-mismatch parity. Fully principled WB-baked
            // handling (`wb_already_baked = true`) regressed the harness
            // (from 14 → 28 ΔE) — investigation deferred; the empirical
            // path matches Adobe's implicit pipeline closely enough.
            (r_norm.powf(2.4), g_norm.powf(2.4), b_norm.powf(2.4))
        } else {
            // High-bit-depth linear DNG: data is already linear and
            // WB-baked. Multiply by AsShotNeutral to put data in the
            // same camera-RGB space the Bayer pipeline produces.
            (r_norm * asn_r, g_norm * asn_g, b_norm * asn_b)
        };
        *px = [r, g, b];
    });
    Ok(img)
}

#[cfg(test)]
mod tests {
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
            color_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
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
            100, 200, 300,
            // px 1: R=400  G=500  B=600
            400, 500, 600,
            // px 2: R=700  G=800  B=900
            700, 800, 900,
            // px 3: R=1000 G=1100 B=1200
            1000, 1100, 1200,
        ];
        let raw = RawImage {
            width: 2, height: 2,
            cfa: CfaPattern::LinearRgb,
            black_level: [0, 0, 0, 0],
            white_level: 1500,
            raw_data,
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
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
                assert!((got - want).abs() < 1e-5,
                    "pixel {} channel {}: got {}, want {}", k, c, got, want);
            }
        }
    }

    /// Regression test for ticket #07: `linearraw_to_camera_rgb` undoes the
    /// converter's AsShotNeutral pre-bake. A neutral patch in the LinearRaw
    /// file (raw value `(K, K, K)` for some K) should land at
    /// `(K × asn[0], K × asn[1], K × asn[2]) / white_level` after the helper
    /// — i.e. the pre-WB camera reading.
    #[test]
    fn linearraw_to_camera_rgb_undoes_as_shot_neutral_pre_bake() {
        // Adobe LinearRaw of a neutral patch reads roughly (K, K, K). Use a
        // typical Canon AsShotNeutral [0.606, 1.0, 0.462] and verify the
        // helper restores the pre-WB camera reading.
        let raw_data: Vec<u16> = vec![100, 100, 100]; // 1 px neutral
        let raw = RawImage {
            width: 1, height: 1,
            cfa: CfaPattern::LinearRgb,
            black_level: [0, 0, 0, 0],
            white_level: 1000,
            raw_data,
            as_shot_neutral: [0.606276, 1.0, 0.46188504],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let img = linearraw_to_camera_rgb(&raw).expect("LinearRaw decode");
        let p = img.pixels[0];
        let n = 100.0 / 1000.0; // raw / white_level
        let expected = [n * 0.606276, n * 1.0, n * 0.46188504];
        for c in 0..3 {
            assert!((p[c] - expected[c]).abs() < 1e-5,
                "channel {}: got {}, want {} (n × asn[{}] = {} × {} = {})",
                c, p[c], expected[c], c, n, raw.as_shot_neutral[c], expected[c]);
        }
    }

    /// Regression test for ticket #07: `linearraw_to_camera_rgb` rejects
    /// `raw_data` lengths that aren't 3 × w × h with a clear `Error::Decode`.
    #[test]
    fn linearraw_to_camera_rgb_rejects_wrong_buffer_length() {
        let raw = RawImage {
            width: 4, height: 4,
            cfa: CfaPattern::LinearRgb,
            black_level: [0, 0, 0, 0],
            white_level: 1023,
            // Length 16 instead of 48 — should error.
            raw_data: vec![0; 16],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let err = linearraw_to_camera_rgb(&raw).unwrap_err();
        match err {
            crate::Error::Decode { reason, .. } => {
                assert!(reason.contains("LinearRaw raw_data length"),
                    "unexpected error message: {}", reason);
            }
            other => panic!("expected Error::Decode, got {:?}", other),
        }
    }
}
