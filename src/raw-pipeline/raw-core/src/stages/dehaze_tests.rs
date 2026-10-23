//! Unit tests for [`super`] (dark-channel-prior dehaze) and its proxy haze
//! map (#3287). Split out of `dehaze.rs` under the 600-LOC file-size budget.

use super::map::*;
use super::*;

fn plane(img: &Image) -> Vec<[f32; 3]> {
    img.pixels.clone()
}

fn dark_channel(img: &Image) -> Vec<f32> {
    let mins: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| p[0].min(p[1]).min(p[2]))
        .collect();
    window_min(&mins, img.width as usize, img.height as usize)
}

fn guided(guide: &[f32], p: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    guided_coefficients(guide, p, w, h, r, 1e-3)
        .iter()
        .zip(guide)
        .map(|(c, &g)| c[0] * g + c[1])
        .collect()
}

#[test]
fn dark_channel_of_uniform_is_min_channel() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.5, 0.3, 0.8];
    }
    let dc = dark_channel(&img);
    assert!(dc.iter().all(|v| (*v - 0.3).abs() < 1e-5));
}

#[test]
fn dark_channel_single_dark_pixel_spreads_across_neighborhood() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.9, 0.9, 0.9];
    }
    img.pixels[10 * 20 + 10] = [0.1, 0.1, 0.1];
    let dc = dark_channel(&img);
    // All pixels within radius 7 of (10,10) should see the dark pixel.
    assert!((dc[10 * 20 + 10] - 0.1).abs() < 1e-5);
    assert!((dc[3 * 20 + 3] - 0.1).abs() < 1e-5);
    // A pixel at (0, 0) — distance 14 — sees 0.9 because 14 > radius 7.
    assert!((dc[0] - 0.9).abs() < 1e-5);
}

#[test]
fn atmospheric_light_picks_brightest_region() {
    let mut img = Image::new(100, 100, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    for y in 0..10 {
        for x in 0..10 {
            img.pixels[y * 100 + x] = [0.95, 0.94, 0.93];
        }
    }
    let dc = dark_channel(&img);
    let a = atmospheric_light(&plane(&img), &dc);
    assert!(a[0] > 0.7, "A[R] = {}", a[0]);
    assert!(a[1] > 0.7);
    assert!(a[2] > 0.7);
}

#[test]
fn transmission_is_high_for_bright_clear_regions() {
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [1.0, 1.0, 1.0];
    }
    let map = measure_proxy(&plane(&img), 30, 30);
    assert_eq!(map.airlight, [1.0; 3]);
    // t = 1 - 0.95 * 1 = 0.05 for pure-white image with A=(1,1,1); a flat
    // guide leaves the whole transmission in the `b` coefficient.
    assert!(map
        .coefficients
        .iter()
        .all(|c| (c[0] * guide([1.0; 3], map.airlight) + c[1] - 0.05).abs() < 1e-5));
}

#[test]
fn box_blur_of_constant_is_constant() {
    let buf = vec![0.5f32; 40 * 40];
    let out = box_blur(&buf, 40, 40, 5);
    assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-5));
}

#[test]
fn guided_filter_of_constants_is_constant() {
    let guide = vec![0.5f32; 40 * 40];
    let p = vec![0.7f32; 40 * 40];
    let out = guided(&guide, &p, 40, 40, 5);
    assert!(out.iter().all(|v| (*v - 0.7).abs() < 1e-4));
}

#[test]
fn guided_filter_preserves_smooth_transmission() {
    let w = 30;
    let h = 30;
    let mut p = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            p[y * w + x] = 0.3 + 0.4 * (x as f32) / (w as f32);
        }
    }
    let guide = p.clone();
    let out = guided(&guide, &p, w, h, 8);
    for y in 10..20 {
        for x in 10..20 {
            let diff = (out[y * w + x] - p[y * w + x]).abs();
            assert!(diff < 0.05, "diff {} at ({},{})", diff, x, y);
        }
    }
}

#[test]
fn guided_filter_flat_bright_plane_stays_flat_and_finite() {
    // Regression for #1177: box-mean roundoff can drive
    // `mean_ii - mean_i * mean_i` negative when the guide runs at
    // scene-linear magnitudes >> 1, flipping the `var_i + eps` denominator
    // sign and blowing `a` up unboundedly. A flat plane must stay flat and
    // finite through the guided filter regardless of its absolute level.
    let w = 64usize;
    let h = 64usize;
    // Non-round value so the box-blur accumulators actually round.
    let level = 3000.7f32;
    let p = vec![level; w * h];
    let out = guided(&p, &p, w, h, 5);
    for (i, &v) in out.iter().enumerate() {
        assert!(v.is_finite(), "index {} non-finite: {}", i, v);
        assert!(
            (v - level).abs() / level < 1e-2,
            "index {} drifted off the flat {}: {}",
            i,
            level,
            v
        );
    }
}

#[test]
fn dehaze_zero_is_identity() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.4, 0.5, 0.6];
    }
    let before = img.pixels.clone();
    apply(&mut img, 0.0);
    for (a, b) in img.pixels.iter().zip(before.iter()) {
        assert_eq!(a, b);
    }
}

#[test]
fn dehaze_negative_uses_forward_haze_model() {
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.10, 0.20, 0.30];
    let a = [0.80, 0.90, 1.00];

    recover_with_mask(&mut img, -50.0, &[0.40], a, &[0.0]);

    // haze=0.5 maps t=0.4 halfway from identity transmission 1.0:
    // t_haze=0.7, output=I*0.7 + A*0.3.
    let expected = [0.31, 0.41, 0.51];
    for (actual, expected) in img.pixels[0].iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "negative dehaze must move toward airlight: {actual} != {expected}"
        );
    }
}

#[test]
fn sky_mask_is_zero_for_hazy_pixels_one_for_sky() {
    // Hazy mid-distance pixel: dc ~ 0.3 → mask 0.
    // Sky pixel: dc ~ 0.85 → mask 1.
    // Transition is smooth.
    let dc = vec![0.30f32, 0.45, 0.50, 0.55, 0.85];
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    assert!(raw[0] < 1e-5, "haze sample should be 0, got {}", raw[0]);
    assert!(
        raw[4] > 1.0 - 1e-5,
        "sky sample should be 1, got {}",
        raw[4]
    );
    // Monotonically non-decreasing.
    for i in 1..raw.len() {
        assert!(
            raw[i] >= raw[i - 1] - 1e-6,
            "smoothstep not monotone at {}: {} -> {}",
            i,
            raw[i - 1],
            raw[i]
        );
    }
    // Mid-band (0.50, the arithmetic midpoint of SKY_MASK_LOW..SKY_MASK_HIGH)
    // is around 0.5.
    assert!(
        (raw[2] - 0.5).abs() < 0.1,
        "midpoint near 0.5, got {}",
        raw[2]
    );
}

#[test]
fn smoothstep_matches_glsl_definition() {
    assert_eq!(smoothstep(0.0, 1.0, -0.5), 0.0);
    assert_eq!(smoothstep(0.0, 1.0, 1.5), 1.0);
    // smoothstep(0, 1, 0.5) = 0.5 by symmetry of 3t² − 2t³ around t=0.5.
    assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
}

/// Build the synthetic split scene used by `dehaze_preserves_sky_attacks_haze`
/// and the companion "without mask the test fails" assertion below.
/// Sky on top half, hazy mid-distance content on the bottom half with a
/// low-contrast checker that exercises the DCP path.
///
/// The sky is `0.85` everywhere except a small "specular" patch at `0.97`
/// that pulls the estimated atmospheric light `A` above the sky body.
/// Without that separation `A ≈ sky` and `J = (I − A)/t + A ≈ I` even
/// without the mask, which would make the mask un-testable (Copilot
/// review on PR #316 flagged this).
fn build_sky_haze_scene(w: usize, h: usize) -> Image {
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            if y < h / 2 {
                // Sky proxy: every channel high → dark channel is also high.
                img.pixels[y * w + x] = [0.85, 0.85, 0.85];
            } else {
                // Hazy base + low-contrast feature.
                let dark_feature = (x / 6) % 2 == 0 && (y / 6) % 2 == 0;
                let v = if dark_feature { 0.22 } else { 0.30 };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
    }
    // Add a bright "specular" patch in the sky corner so the atmospheric-
    // light estimator A lands distinctly *above* the sky body (0.85).
    // Atmospheric_light picks the top-dc positions and averages the
    // original pixels there. The patch must be larger than the dark-
    // channel neighbourhood (15×15) so its interior pixels have dc =
    // patch brightness rather than being min-filtered down to the
    // surrounding sky level. With a 20×20 patch, the centre cells have
    // 15×15 neighbourhoods fully inside the patch and dc = 0.95 — which
    // sorts above the sky body's dc = 0.85, so A ≈ [0.95, 0.95, 0.95].
    // That gives the sky body a meaningful (I − A) = −0.10 to amplify,
    // which is what makes the no-mask path move the sky.
    for y in 0..20 {
        for x in 0..20 {
            img.pixels[y * w + x] = [0.95, 0.95, 0.95];
        }
    }
    img
}

/// Maximum per-channel relative change between `before` and `after` over
/// the row range `[y0, y1)`.
fn max_rel_change(before: &[[f32; 3]], after: &[[f32; 3]], w: usize, y0: usize, y1: usize) -> f32 {
    let mut max_rel = 0.0f32;
    for y in y0..y1 {
        for x in 0..w {
            let b = before[y * w + x];
            let a = after[y * w + x];
            for c in 0..3 {
                let rel = (a[c] - b[c]).abs() / b[c].max(1e-6);
                if rel > max_rel {
                    max_rel = rel;
                }
            }
        }
    }
    max_rel
}

#[test]
fn dehaze_preserves_sky_attacks_haze() {
    // Synthetic split scene (issue #272): bright "sky" on top, hazy mid-
    // distance content on the bottom. At dehaze=+100 the sky must barely
    // move (< 5% per channel) and the hazy region must change substantially.
    let w = 60usize;
    let h = 60usize;
    let mut img = build_sky_haze_scene(w, h);
    let before = img.pixels.clone();
    apply(&mut img, 100.0);

    // Pure-sky band (top quarter, well clear of the haze boundary): the
    // mask is fully saturated here, so per-channel change must stay under
    // 5%. Boundary rows in the lower-sky band are intentionally excluded —
    // the mask feathers there by design, so the pixels move some
    // (small) amount. The "without mask, sky moves substantially"
    // assertion in `dehaze_without_sky_mask_breaks_sky_preservation`
    // covers the load-bearing claim that the mask is what suppresses
    // movement in the sky.
    let pure_sky_rows = h / 4;
    for y in 0..pure_sky_rows {
        for x in 0..w {
            let b = before[y * w + x];
            let a = img.pixels[y * w + x];
            for c in 0..3 {
                let rel = (a[c] - b[c]).abs() / b[c].max(1e-6);
                assert!(
                    rel < 0.05,
                    "sky pixel ({}, {}) ch{} moved {:.3} → {:.3} (rel {:.3})",
                    x,
                    y,
                    c,
                    b[c],
                    a[c],
                    rel
                );
            }
        }
    }
    // Hazy half: at least one strong-feature pixel must change substantially.
    let haze_max_rel = max_rel_change(&before, &img.pixels, w, h / 2, h);
    assert!(
        haze_max_rel > 0.10,
        "expected dehaze to substantially modify the hazy half, got max rel {:.3}",
        haze_max_rel
    );
}

/// Companion to `dehaze_preserves_sky_attacks_haze`: prove the sky mask is
/// load-bearing. Re-runs the same recovery math but with the mask forced
/// to zero everywhere — the sky-preservation property must FAIL, i.e. the
/// pure-sky band must move by *much* more than the 5%-per-channel
/// ceiling the masked variant enforces. If this assertion ever fires,
/// the masked test is no longer load-bearing evidence that the mask
/// works.
#[test]
fn dehaze_without_sky_mask_breaks_sky_preservation() {
    let w = 60usize;
    let h = 60usize;
    let mut img = build_sky_haze_scene(w, h);
    let before = img.pixels.clone();

    // Run the full recovery pipeline with a zero mask (mask disabled).
    let mut map = HazeMap::measure(&img);
    map.sky.fill(0.0);
    apply_with_map(&mut img, 100.0, &map, (0, 0), (w as u32, h as u32));

    // Check the exact same pure-sky band the masked test asserts on.
    // The masked test requires every pixel-channel here to move < 5%;
    // the no-mask path must blow well past that — we require > 20% to
    // leave headroom and make the contrast unambiguous.
    let pure_sky_rows = h / 4;
    let sky_max_rel = max_rel_change(&before, &img.pixels, w, 0, pure_sky_rows);
    assert!(
        sky_max_rel > 0.20,
        "without the sky mask the sky should move substantially, got max rel {:.3} \
         (if this fires, the masked sky-preservation test is no longer load-bearing \
         evidence that the mask works)",
        sky_max_rel
    );
}

#[test]
fn dehaze_positive_increases_contrast() {
    // A flat hazy field with a slightly darker region should remain finite
    // and within reasonable bounds after dehaze.
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.5, 0.5, 0.5];
    }
    for y in 10..20 {
        for x in 10..20 {
            img.pixels[y * 30 + x] = [0.35, 0.35, 0.35];
        }
    }
    apply(&mut img, 100.0);
    assert!(img.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
    let after = img.pixels[10 * 30 + 10][0];
    assert!(after >= 0.0 && after <= 1.5);
}

#[test]
fn separable_window_min_matches_the_direct_clamped_window() {
    let (w, h) = (37usize, 23usize);
    let values: Vec<f32> = (0..w * h)
        .map(|i| ((i * 7919) % 1009) as f32 / 1009.0)
        .collect();
    let fast = window_min(&values, w, h);
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -7i32..=7 {
                for dx in -7i32..=7 {
                    let ux = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
                    let uy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
                    m = m.min(values[uy * w + ux]);
                }
            }
            assert_eq!(fast[y * w + x], m, "({x}, {y})");
        }
    }
}

#[test]
fn proxy_grid_has_the_fixed_long_edge_and_keeps_aspect() {
    assert_eq!(proxy_dims(12288, 8192), (2048, 1365));
    assert_eq!(proxy_dims(4000, 6000), (1365, 2048));
    assert_eq!(proxy_dims(60, 60), (2048, 2048));
    assert_eq!(proxy_dims(9000, 1), (2048, 1));
}

/// A synthetic hazy landscape: a veil that thickens towards the horizon,
/// darker objects on the ground and a bright sky, sampled as the block
/// average of a continuous scene so every resolution sees the same picture.
fn hazy_scene(w: u32, h: u32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            let (u, v) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let veil = 0.25 + 0.5 * (1.0 - v);
            let object = ((u * 9.0).floor() as i32 + (v * 6.0).floor() as i32) % 2 == 0;
            let albedo = if object {
                [0.05, 0.08, 0.04]
            } else {
                [0.18, 0.16, 0.12]
            };
            img.pixels[(y * w + x) as usize] = if v < 0.2 {
                [0.9, 0.92, 0.95]
            } else {
                [0, 1, 2].map(|c| albedo[c] * (1.0 - veil) + 0.85 * veil)
            };
        }
    }
    img
}

fn block_average(img: &Image, factor: u32) -> Image {
    let (w, h) = (img.width / factor, img.height / factor);
    let mut out = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0.0f32; 3];
            for dy in 0..factor {
                for dx in 0..factor {
                    let p = img.pixels[((y * factor + dy) * img.width + x * factor + dx) as usize];
                    (0..3).for_each(|c| sum[c] += p[c]);
                }
            }
            let n = (factor * factor) as f32;
            out.pixels[(y * w + x) as usize] = sum.map(|s| s / n);
        }
    }
    out
}

#[test]
fn dehaze_looks_the_same_at_fit_and_at_native_resolution() {
    let native_in = hazy_scene(3072, 2046);
    let fit_in = block_average(&native_in, 3);
    for amount in [50.0, -50.0, 100.0] {
        let mut native = native_in.clone();
        apply(&mut native, amount);
        let mut fit = fit_in.clone();
        apply(&mut fit, amount);
        let native_at_fit = block_average(&native, 3);
        let mut errors: Vec<f32> = native_at_fit
            .pixels
            .iter()
            .zip(&fit.pixels)
            .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
            .collect();
        let moved = fit
            .pixels
            .iter()
            .zip(&fit_in.pixels)
            .map(|(a, b)| (a[1] - b[1]).abs())
            .fold(0.0f32, f32::max);
        errors.sort_by(f32::total_cmp);
        let mean = errors.iter().sum::<f32>() / errors.len() as f32;
        let p99 = errors[errors.len() * 99 / 100];
        assert!(moved > 0.05, "{amount}: dehaze must act, moved {moved}");
        assert!(
            mean < 5e-4 && p99 < 5e-3,
            "{amount}: fit vs native mean {mean} p99 {p99}"
        );
    }
    // Load-bearing: measuring in each buffer's own pixels (the pre-#3287
    // stage) puts the same scene measurably further apart.
    let own = |img: &Image| {
        let map = measure_proxy(&img.pixels, img.width as usize, img.height as usize);
        let mut out = img.clone();
        apply_with_map(&mut out, 100.0, &map, (0, 0), (img.width, img.height));
        out
    };
    let native_at_fit = block_average(&own(&native_in), 3);
    let fit = own(&fit_in);
    let mean = native_at_fit
        .pixels
        .iter()
        .zip(&fit.pixels)
        .map(|(a, b)| (0..3).map(|c| (a[c] - b[c]).abs()).sum::<f32>() / 3.0)
        .sum::<f32>()
        / fit.pixels.len() as f32;
    assert!(
        mean > 5e-4,
        "buffer-pixel windows should differ, mean {mean}"
    );
}

#[test]
fn a_window_recovers_exactly_like_the_whole_frame_from_the_frame_map() {
    let frame = hazy_scene(640, 427);
    let map = HazeMap::measure(&frame);
    let mut whole = frame.clone();
    apply(&mut whole, 60.0);
    let (x0, y0, w, h) = (217u32, 101u32, 150u32, 90u32);
    let mut window = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            window.pixels[(y * w + x) as usize] =
                frame.pixels[((y0 + y) * frame.width + x0 + x) as usize];
        }
    }
    apply_with_map(
        &mut window,
        60.0,
        &map,
        (x0 as i32, y0 as i32),
        (frame.width, frame.height),
    );
    for y in 0..h {
        for x in 0..w {
            assert_eq!(
                window.pixels[(y * w + x) as usize].map(f32::to_bits),
                whole.pixels[((y0 + y) * frame.width + x0 + x) as usize].map(f32::to_bits),
                "({x}, {y})"
            );
        }
    }
}

#[test]
fn the_map_does_not_depend_on_the_amount() {
    let frame = hazy_scene(300, 200);
    let map = HazeMap::measure(&frame);
    for amount in [25.0, -80.0] {
        let mut measured = frame.clone();
        apply(&mut measured, amount);
        let mut reused = frame.clone();
        apply_with_map(&mut reused, amount, &map, (0, 0), (300, 200));
        assert_eq!(measured.pixels, reused.pixels);
    }
}
