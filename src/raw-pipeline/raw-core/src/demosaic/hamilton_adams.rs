//! Hamilton-Adams demosaic per spec § 3.3.3.
//!
//! Green is interpolated first via a directional gradient test; red and
//! blue are then interpolated using color-difference smoothness. Falls
//! back to bilinear in a 2-pixel border where the 5-wide neighborhood
//! doesn't fit.

use super::bilinear::bilinear;
use crate::image::{CfaPattern, ColorSpace, Image};

/// Hamilton-Adams demosaic. Input must be `CameraNativeMosaic` with a 3-
/// channel pixel buffer where only the CFA-appropriate channel carries data.
pub fn hamilton_adams(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as i32;
    let h = mosaic.height as i32;

    // Seed output with a bilinear fallback for the borders (2-pixel edge).
    let mut out = bilinear(mosaic, cfa);

    // Only interior pixels (x in 2..w-2, y in 2..h-2) get the HA treatment.
    if w < 5 || h < 5 {
        return out; // Too small; bilinear result is the best we can do.
    }

    let sample = |x: i32, y: i32, channel: usize| -> f32 {
        mosaic.pixels[(y as usize) * (w as usize) + (x as usize)][channel]
    };

    // --- Step 1: Green at R/B positions ---
    let mut green_buf: Vec<f32> = out.pixels.iter().map(|p| p[1]).collect();
    for y in 2..h - 2 {
        for x in 2..w - 2 {
            let color = cfa.color_at(x as u32, y as u32) as usize;
            if color == 1 {
                continue;
            } // Already have G at G positions.
            let center = sample(x, y, color);
            // Horizontal gradient: change in G + color-diff smoothness.
            let g_left = sample(x - 1, y, 1);
            let g_right = sample(x + 1, y, 1);
            let r_left = sample(x - 2, y, color);
            let r_right = sample(x + 2, y, color);
            let dh = (g_right - g_left).abs() + (center - (r_left + r_right) * 0.5).abs();
            // Vertical gradient:
            let g_up = sample(x, y - 1, 1);
            let g_down = sample(x, y + 1, 1);
            let r_up = sample(x, y - 2, color);
            let r_down = sample(x, y + 2, color);
            let dv = (g_down - g_up).abs() + (center - (r_up + r_down) * 0.5).abs();

            let g_est = if dh < dv {
                (g_left + g_right) * 0.5 + (2.0 * center - r_left - r_right) * 0.25
            } else if dv < dh {
                (g_up + g_down) * 0.5 + (2.0 * center - r_up - r_down) * 0.25
            } else {
                // Tie: average the two estimates.
                let gh = (g_left + g_right) * 0.5 + (2.0 * center - r_left - r_right) * 0.25;
                let gv = (g_up + g_down) * 0.5 + (2.0 * center - r_up - r_down) * 0.25;
                (gh + gv) * 0.5
            };
            green_buf[(y as usize) * (w as usize) + (x as usize)] = g_est;
        }
    }
    for (i, p) in out.pixels.iter_mut().enumerate() {
        p[1] = green_buf[i];
    }

    // --- Step 2/3/4: Red and Blue using color-difference smoothness ---
    // At G positions, one chroma is horizontal-adjacent, the other vertical.
    // At R positions, B is diagonal. At B positions, R is diagonal.
    let green = |x: i32, y: i32| -> f32 { green_buf[(y as usize) * (w as usize) + (x as usize)] };

    for y in 2..h - 2 {
        for x in 2..w - 2 {
            let color_here = cfa.color_at(x as u32, y as u32) as usize;
            if color_here == 1 {
                // G position: R neighbors on one axis, B on the other.
                let horiz_c = cfa.color_at(x as u32 + 1, y as u32) as usize;
                let vert_c = cfa.color_at(x as u32, y as u32 + 1) as usize;

                let c_left = sample(x - 1, y, horiz_c);
                let c_right = sample(x + 1, y, horiz_c);
                let g_left = green(x - 1, y);
                let g_right = green(x + 1, y);
                let horiz_est = green(x, y) + ((c_left - g_left) + (c_right - g_right)) * 0.5;

                let c_up = sample(x, y - 1, vert_c);
                let c_down = sample(x, y + 1, vert_c);
                let g_up = green(x, y - 1);
                let g_down = green(x, y + 1);
                let vert_est = green(x, y) + ((c_up - g_up) + (c_down - g_down)) * 0.5;

                out.pixels[(y as usize) * (w as usize) + (x as usize)][horiz_c] = horiz_est;
                out.pixels[(y as usize) * (w as usize) + (x as usize)][vert_c] = vert_est;
            } else {
                // R or B position: the opposite chroma is on diagonals.
                let other = if color_here == 0 { 2 } else { 0 };
                let c_ul = sample(x - 1, y - 1, other);
                let c_ur = sample(x + 1, y - 1, other);
                let c_dl = sample(x - 1, y + 1, other);
                let c_dr = sample(x + 1, y + 1, other);
                let g_ul = green(x - 1, y - 1);
                let g_ur = green(x + 1, y - 1);
                let g_dl = green(x - 1, y + 1);
                let g_dr = green(x + 1, y + 1);
                let c_est = green(x, y)
                    + ((c_ul - g_ul) + (c_ur - g_ur) + (c_dl - g_dl) + (c_dr - g_dr)) * 0.25;
                out.pixels[(y as usize) * (w as usize) + (x as usize)][other] = c_est;
            }
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
                let v = match c {
                    0 => r,
                    1 => g,
                    2 => b,
                    _ => 0.0,
                };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        img
    }

    #[test]
    fn ha_uniform_input_produces_uniform_output() {
        let mosaic = rggb_uniform(10, 10, 0.4, 0.5, 0.6);
        let out = hamilton_adams(&mosaic, CfaPattern::Rggb);
        // Interior pixels should match. Border pixels from bilinear fallback may also
        // match because bilinear of uniform input is uniform; check all.
        for p in &out.pixels {
            assert!((p[0] - 0.4).abs() < 1e-4, "R: {}", p[0]);
            assert!((p[1] - 0.5).abs() < 1e-4, "G: {}", p[1]);
            assert!((p[2] - 0.6).abs() < 1e-4, "B: {}", p[2]);
        }
    }

    #[test]
    fn ha_output_space() {
        let mosaic = rggb_uniform(10, 10, 0.1, 0.1, 0.1);
        let out = hamilton_adams(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn ha_small_image_falls_back_to_bilinear() {
        // 4x4 is smaller than 5-wide neighborhood → bilinear only.
        let mosaic = rggb_uniform(4, 4, 0.2, 0.3, 0.4);
        let out = hamilton_adams(&mosaic, CfaPattern::Rggb);
        for p in &out.pixels {
            assert!((p[0] - 0.2).abs() < 1e-4);
        }
    }
}
