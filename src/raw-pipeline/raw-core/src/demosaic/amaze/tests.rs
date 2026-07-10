use super::amaze;
use crate::image::{CfaPattern, ColorSpace, Image};

/// Build a Bayer-mosaic `Image` of constant per-channel values for the
/// requested CFA. Mirrors the helper in the `hamilton_adams` tests so the
/// input contract is identical.
fn uniform(w: u32, h: u32, cfa: CfaPattern, r: f32, g: f32, b: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
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

/// Synthesise a vertical-step-edge mosaic: scene goes from `low` to `high`
/// at `x_split`. Each CFA position carries the appropriate scene channel, so
/// a sharp edge in the scene means a sharp edge in every channel when
/// correctly demosaiced.
fn step_mosaic(w: u32, h: u32, x_split: u32, low: f32, high: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    let cfa = CfaPattern::Rggb;
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            let v = if x < x_split { low } else { high };
            img.pixels[(y * w + x) as usize][c] = v;
        }
    }
    img
}

/// A smooth two-axis luminance gradient — no CFA-visible texture, so the
/// reconstruction must be smooth everywhere, in particular across the
/// 128-px tile seams.
fn gradient_mosaic(w: u32, h: u32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    let cfa = CfaPattern::Rggb;
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            let v = 0.1 + 0.6 * (x as f32 / w as f32) * 0.5 * (1.0 + y as f32 / h as f32);
            img.pixels[(y * w + x) as usize][c] = v;
        }
    }
    img
}

#[test]
fn amaze_uniform_input_produces_uniform_output() {
    let mosaic = uniform(32, 32, CfaPattern::Rggb, 0.4, 0.5, 0.6);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    for p in &out.pixels {
        assert!((p[0] - 0.4).abs() < 5e-3, "R: {}", p[0]);
        assert!((p[1] - 0.5).abs() < 5e-3, "G: {}", p[1]);
        assert!((p[2] - 0.6).abs() < 5e-3, "B: {}", p[2]);
    }
}

#[test]
fn amaze_uniform_multi_tile_covers_every_pixel() {
    // 300×200 spans three tile columns and two bands. Any pixel a tile
    // failed to write would stay 0 and fail loudly.
    let mosaic = uniform(300, 200, CfaPattern::Rggb, 0.4, 0.5, 0.6);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    for (i, p) in out.pixels.iter().enumerate() {
        assert!(
            (p[0] - 0.4).abs() < 5e-3 && (p[1] - 0.5).abs() < 5e-3 && (p[2] - 0.6).abs() < 5e-3,
            "pixel {} = {:?}",
            i,
            p
        );
    }
}

#[test]
fn amaze_output_space_is_camera_native_rgb() {
    let mosaic = uniform(20, 20, CfaPattern::Rggb, 0.1, 0.1, 0.1);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
}

#[test]
fn amaze_small_image_falls_back_to_hamilton_adams() {
    // Below the 17-px threshold the function should not panic on
    // out-of-range indices and should return a valid `Image` of the same
    // dimensions as the input.
    let mosaic = uniform(8, 8, CfaPattern::Rggb, 0.2, 0.3, 0.4);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    assert_eq!(out.width, 8);
    assert_eq!(out.height, 8);
    assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    for p in &out.pixels {
        assert!((p[0] - 0.2).abs() < 1e-3);
        assert!((p[1] - 0.3).abs() < 1e-3);
        assert!((p[2] - 0.4).abs() < 1e-3);
    }
}

#[test]
fn amaze_step_edge_keeps_sharpness() {
    // A sharp vertical step at column 20 — across the edge the green delta
    // should retain most of the scene contrast. AMaZE's adaptive H/V
    // weighting must detect the vertical edge and keep horizontal
    // interpolations from blurring it.
    let mosaic = step_mosaic(48, 48, 20, 0.2, 0.8);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    let g_left = out.pixels[24 * 48 + 18][1];
    let g_right = out.pixels[24 * 48 + 21][1];
    let edge = (g_right - g_left).abs();
    assert!(
        edge > 0.4,
        "edge collapsed: g_left={} g_right={} delta={}",
        g_left,
        g_right,
        edge
    );
}

#[test]
fn amaze_bggr_pattern_works() {
    let mosaic = uniform(20, 20, CfaPattern::Bggr, 0.7, 0.5, 0.3);
    let out = amaze(&mosaic, CfaPattern::Bggr);
    for y in 8..12 {
        for x in 8..12 {
            let p = out.pixels[y * 20 + x];
            assert!((p[0] - 0.7).abs() < 5e-3, "R: {}", p[0]);
            assert!((p[1] - 0.5).abs() < 5e-3, "G: {}", p[1]);
            assert!((p[2] - 0.3).abs() < 5e-3, "B: {}", p[2]);
        }
    }
}

#[test]
fn amaze_grbg_pattern_works() {
    let mosaic = uniform(20, 20, CfaPattern::Grbg, 0.4, 0.5, 0.6);
    let out = amaze(&mosaic, CfaPattern::Grbg);
    for y in 8..12 {
        for x in 8..12 {
            let p = out.pixels[y * 20 + x];
            assert!((p[0] - 0.4).abs() < 5e-3);
            assert!((p[1] - 0.5).abs() < 5e-3);
            assert!((p[2] - 0.6).abs() < 5e-3);
        }
    }
}

#[test]
fn amaze_no_nan_on_zero_input() {
    // All zeros — divisions by `dirwts` could produce NaN if the EPS floor
    // weren't there.
    let mosaic = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    for p in &out.pixels {
        assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite());
        assert!(p[0].abs() < 1e-3);
        assert!(p[1].abs() < 1e-3);
        assert!(p[2].abs() < 1e-3);
    }
}

#[test]
fn amaze_deterministic_same_input_same_output() {
    // Same RAW + same algorithm = same bytes, across a multi-band,
    // multi-tile frame — guards against rayon scheduling leaking into the
    // result (tile interiors must be disjoint and input-only).
    let mosaic = gradient_mosaic(300, 300);
    let a = amaze(&mosaic, CfaPattern::Rggb);
    let b = amaze(&mosaic, CfaPattern::Rggb);
    assert_eq!(a.width, b.width);
    assert_eq!(a.height, b.height);
    for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
        assert_eq!(pa, pb);
    }
}

#[test]
fn amaze_smooth_gradient_has_no_tile_seams() {
    // A smooth gradient must reconstruct smoothly across the 128-px tile
    // boundaries: the second difference across every seam row/column stays
    // in the same range as far from the seam. A halo or fill bug shows up
    // as a step at x or y ∈ {128, 256}.
    let mosaic = gradient_mosaic(300, 300);
    let out = amaze(&mosaic, CfaPattern::Rggb);
    let px = |x: usize, y: usize, ch: usize| out.pixels[y * 300 + x][ch];
    for &seam in &[128usize, 256] {
        // `k` sweeps the full length of each seam: the y-coordinate along
        // the vertical (column) seam at x == seam, and the x-coordinate
        // along the horizontal (row) seam at y == seam.
        for k in 20..280 {
            for ch in 0..3 {
                let (a, b, c) = (px(seam - 1, k, ch), px(seam, k, ch), px(seam + 1, k, ch));
                assert!(
                    (a - 2.0 * b + c).abs() < 5e-3,
                    "column seam at x={} y={} ch={}: {} {} {}",
                    seam,
                    k,
                    ch,
                    a,
                    b,
                    c
                );
                let (a, b, c) = (px(k, seam - 1, ch), px(k, seam, ch), px(k, seam + 1, ch));
                assert!(
                    (a - 2.0 * b + c).abs() < 5e-3,
                    "row seam at y={} x={} ch={}: {} {} {}",
                    seam,
                    k,
                    ch,
                    a,
                    b,
                    c
                );
            }
        }
    }
}
