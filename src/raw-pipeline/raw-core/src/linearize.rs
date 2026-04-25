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
    debug_assert_ne!(raw.cfa, CfaPattern::LinearRgb,
        "sensor_linearize must not be called on LinearRgb data; \
         use linearraw_to_camera_rgb instead. See ticket #07.");

    let w = raw.width as usize;
    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeMosaic);

    let wl = raw.white_level as f32;
    img.pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let raw_row = &raw.raw_data[y * w..(y + 1) * w];
            for (x, px) in row.iter_mut().enumerate() {
                // Per-CFA-position black level: index as 2*(y&1) + (x&1).
                let bl_idx = ((y & 1) << 1) | (x & 1);
                let bl = raw.black_level[bl_idx] as f32;
                let denom = (wl - bl).max(1.0);
                let raw_v = raw_row[x] as f32;
                let v = ((raw_v - bl) / denom).clamp(0.0, 1.0);
                let color = raw.cfa.color_at(x as u32, y as u32) as usize;
                px[color] = v;
            }
        });
    img
}

/// LinearRaw decode entry. Reshape interleaved `[R₀ G₀ B₀ R₁ G₁ B₁ …]`
/// `raw.raw_data` into a `CameraNativeLinearRgb` `Image`, normalizing
/// per-channel by `(white_level - black_level)`. Skips both
/// `sensor_linearize` (1 SPP scanline) and `demosaic::*` because the
/// data is already 3-channel RGB. Caller dispatches based on
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

    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
    img.pixels.par_iter_mut().enumerate().for_each(|(idx, px)| {
        let off = idx * 3;
        let r = ((raw.raw_data[off    ] as f32 - bl_r) / denom_r).clamp(0.0, 1.0);
        let g = ((raw.raw_data[off + 1] as f32 - bl_g) / denom_g).clamp(0.0, 1.0);
        let b = ((raw.raw_data[off + 2] as f32 - bl_b) / denom_b).clamp(0.0, 1.0);
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
}
