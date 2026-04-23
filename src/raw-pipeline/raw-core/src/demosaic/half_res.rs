use crate::image::{CfaPattern, ColorSpace, Image};

/// Half-resolution quad demosaic per spec § 3.3.2.
/// Each 2×2 Bayer quad collapses to one RGB pixel: R at the R position,
/// G is the average of the two Gs, B at the B position. Output is
/// half-width and half-height. Input must be `CameraNativeMosaic`.
///
/// Fast path for large sensors (spec says 100MP Hasselblad drops to 25MP).
/// Non-even sensor dimensions crop one row/column as needed.
pub fn half_res(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let in_w = mosaic.width as usize;
    let in_h = mosaic.height as usize;
    let out_w = in_w / 2;
    let out_h = in_h / 2;
    let mut out = Image::new(out_w as u32, out_h as u32, ColorSpace::CameraNativeLinearRgb);

    // For each 2×2 quad, positions (2x, 2y), (2x+1, 2y), (2x, 2y+1), (2x+1, 2y+1).
    // The color at each is known from cfa.color_at. Collect R, G_sum, G_count, B.
    for y in 0..out_h {
        for x in 0..out_w {
            let positions = [
                (2 * x,     2 * y,     mosaic.pixels[2 * y * in_w + 2 * x]),
                (2 * x + 1, 2 * y,     mosaic.pixels[2 * y * in_w + (2 * x + 1)]),
                (2 * x,     2 * y + 1, mosaic.pixels[(2 * y + 1) * in_w + 2 * x]),
                (2 * x + 1, 2 * y + 1, mosaic.pixels[(2 * y + 1) * in_w + (2 * x + 1)]),
            ];

            let mut rgb = [0.0f32; 3];
            let mut g_sum = 0.0f32;
            let mut g_count = 0.0f32;
            for (px, py, p) in positions.iter() {
                let c = cfa.color_at(*px as u32, *py as u32) as usize;
                // `p[c]` is the only channel populated at that mosaic position.
                if c == 1 {
                    g_sum += p[1];
                    g_count += 1.0;
                } else {
                    rgb[c] = p[c];
                }
            }
            rgb[1] = if g_count > 0.0 { g_sum / g_count } else { 0.0 };
            out.pixels[y * out_w + x] = rgb;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rggb_uniform(w: u32, h: u32, r: f32, g: f32, b: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => r, 1 => g, 2 => b, _ => 0.0 };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        img
    }

    #[test]
    fn half_res_of_uniform_is_uniform() {
        let mosaic = rggb_uniform(8, 8, 0.3, 0.5, 0.7);
        let out = half_res(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.width, 4);
        assert_eq!(out.height, 4);
        for p in &out.pixels {
            assert!((p[0] - 0.3).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.7).abs() < 1e-5);
        }
    }

    #[test]
    fn half_res_output_space_is_rgb() {
        let mosaic = rggb_uniform(4, 4, 0.1, 0.1, 0.1);
        let out = half_res(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn half_res_bggr_works() {
        let mut img = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Bggr;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => 0.8, 1 => 0.4, 2 => 0.2, _ => 0.0 };
                img.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        let out = half_res(&img, CfaPattern::Bggr);
        for p in &out.pixels {
            assert!((p[0] - 0.8).abs() < 1e-5);
            assert!((p[1] - 0.4).abs() < 1e-5);
            assert!((p[2] - 0.2).abs() < 1e-5);
        }
    }
}
