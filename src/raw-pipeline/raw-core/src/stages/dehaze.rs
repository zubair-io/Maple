use crate::image::{ColorSpace, Image};

const DARK_RADIUS: i32 = 7; // 15×15 neighborhood per spec § 3.9.

fn dark_channel(img: &Image) -> Vec<f32> {
    let w = img.width as i32;
    let h = img.height as i32;
    let mut out = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, w - 1) as usize;
                    let uy = (y + dy).clamp(0, h - 1) as usize;
                    let p = img.pixels[uy * (w as usize) + ux];
                    let local_min = p[0].min(p[1]).min(p[2]);
                    if local_min < m { m = local_min; }
                }
            }
            out[(y * w + x) as usize] = m;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_channel_of_uniform_is_min_channel() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.3, 0.8]; }
        let dc = dark_channel(&img);
        assert!(dc.iter().all(|v| (*v - 0.3).abs() < 1e-5));
    }

    #[test]
    fn dark_channel_single_dark_pixel_spreads_across_neighborhood() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.9, 0.9, 0.9]; }
        img.pixels[10 * 20 + 10] = [0.1, 0.1, 0.1];
        let dc = dark_channel(&img);
        // All pixels within radius 7 of (10,10) should see the dark pixel.
        assert!((dc[10 * 20 + 10] - 0.1).abs() < 1e-5);
        assert!((dc[3 * 20 + 3] - 0.1).abs() < 1e-5);
        // A pixel at (0, 0) — distance 14 — sees 0.9 because 14 > radius 7.
        assert!((dc[0] - 0.9).abs() < 1e-5);
    }
}
