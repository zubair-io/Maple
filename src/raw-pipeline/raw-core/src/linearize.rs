use crate::image::{ColorSpace, Image, RawImage};

/// Sensor linearization per spec § 3.2.
/// `linear = (raw - black) / (white - black)` clamped to [0, 1].
/// Produces a three-channel `Image` where only the CFA-appropriate channel is
/// populated per pixel; the other two are zero. (Demosaic fills them in.)
pub fn sensor_linearize(raw: &RawImage) -> Image {
    let w = raw.width as usize;
    let h = raw.height as usize;
    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeMosaic);

    for y in 0..h {
        for x in 0..w {
            // Per-CFA-position black level: index as 2*(y&1) + (x&1).
            let bl_idx = ((y & 1) << 1) | (x & 1);
            let bl = raw.black_level[bl_idx] as f32;
            let wl = raw.white_level as f32;
            let denom = (wl - bl).max(1.0);
            let raw_v = raw.raw_data[y * w + x] as f32;
            let v = ((raw_v - bl) / denom).clamp(0.0, 1.0);
            let color = raw.cfa.color_at(x as u32, y as u32) as usize;
            img.pixels[y * w + x][color] = v;
        }
    }
    img
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
            embedded_color_matrix: None,
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
