use super::*;
use crate::color::oklab::rec2020_to_oklab;

fn noisy(w: u32, h: u32, seed: u32) -> Image {
    scene(w, h, seed, 0.04)
}

fn scene(w: u32, h: u32, seed: u32, noise: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let n = |k: u32| {
            let v = (i as u32 ^ seed)
                .wrapping_mul(0x9E37_79B9)
                .wrapping_add(k.wrapping_mul(0x85EB_CA6B));
            ((v >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * noise
        };
        let x = (i % w as usize) as f32 / w as f32;
        *p = [0.2 + 0.3 * x + n(1), 0.25 + n(2), 0.3 - 0.2 * x + n(3)];
    }
    img
}

fn chroma_error(img: &Image, clean: &Image) -> f32 {
    img.pixels
        .iter()
        .zip(&clean.pixels)
        .map(|(p, q)| {
            let (p, q) = (rec2020_to_oklab(*p), rec2020_to_oklab(*q));
            (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)
        })
        .sum::<f32>()
        / img.pixels.len() as f32
}

fn run(img: &mut Image, amount: f32, origin: (i32, i32)) {
    apply_color_half_res_cancellable(img, amount, CancelToken::never(), None, 100, origin);
}

#[test]
fn zero_amount_is_identity() {
    let mut img = noisy(17, 9, 1);
    let before = img.pixels.clone();
    run(&mut img, 0.0, (0, 0));
    assert_eq!(img.pixels, before);
}

#[test]
fn reduces_chroma_noise_and_keeps_luma() {
    let clean = scene(64, 48, 2, 0.0);
    let mut img = noisy(64, 48, 2);
    let before = img.clone();
    run(&mut img, 100.0, (0, 0));
    assert!(chroma_error(&img, &clean) < 0.5 * chroma_error(&before, &clean));
    for (a, b) in img.pixels.iter().zip(&before.pixels) {
        assert!((rec2020_to_oklab(*a)[0] - rec2020_to_oklab(*b)[0]).abs() < 1e-4);
    }
}

#[test]
fn odd_sizes_and_origins_stay_finite() {
    for (w, h, origin) in [
        (1, 1, (0, 0)),
        (1, 2, (1, 0)),
        (3, 5, (-3, 7)),
        (2, 1, (1, 1)),
    ] {
        let mut img = noisy(w, h, 3);
        run(&mut img, 60.0, origin);
        assert!(img.pixels.iter().flatten().all(|v| v.is_finite()));
    }
}

/// A window cut from the frame at an odd or an even origin, denoised on its
/// own, matches the whole-frame result once the reach band is discarded.
#[test]
fn window_matches_the_frame_inside_the_reach() {
    let (fw, fh) = (96u32, 80u32);
    let mut frame = noisy(fw, fh, 4);
    let source = frame.clone();
    run(&mut frame, 40.0, (0, 0));
    for origin in [(21, 15), (20, 14)] {
        window_matches_at(&source, &frame, fw, origin);
    }
}

fn window_matches_at(source: &Image, frame: &Image, fw: u32, (ox, oy): (u32, u32)) {
    let (ww, wh) = (50u32, 44u32);
    let mut window = Image::new(ww, wh, ColorSpace::SceneLinearRec2020);
    for r in 0..wh {
        for c in 0..ww {
            window.pixels[(r * ww + c) as usize] = source.pixels[((r + oy) * fw + c + ox) as usize];
        }
    }
    run(&mut window, 40.0, (ox as i32, oy as i32));

    let reach = HALF_RES_CHROMA_REACH_PX as u32;
    let inside =
        |c: u32, r: u32| (reach..ww - reach).contains(&c) && (reach..wh - reach).contains(&r);
    let mut band_differs = false;
    for r in 0..wh {
        for c in 0..ww {
            let got = window.pixels[(r * ww + c) as usize];
            let want = frame.pixels[((r + oy) * fw + c + ox) as usize];
            if inside(c, r) {
                assert_eq!(got, want, "origin ({ox}, {oy}): pixel ({c}, {r})");
            } else {
                band_differs |= got != want;
            }
        }
    }
    assert!(
        band_differs,
        "origin ({ox}, {oy}): the edge band never differs, so the reach is untested"
    );
}

fn flat_with_hot_pixel(w: u32, h: u32, at: (u32, u32)) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    img.pixels.fill([0.18, 0.18, 0.18]);
    img.pixels[(at.1 * w + at.0) as usize] = [0.05, 0.004, 0.07];
    img
}

fn chroma_offset(p: [f32; 3], field: [f32; 3]) -> f32 {
    let (p, q) = (rec2020_to_oklab(p), rec2020_to_oklab(field));
    (p[1] - q[1]).hypot(p[2] - q[2])
}

/// The `test_0013` defect (#6018 follow-up): an isolated dark hot pixel kept
/// three quarters of its chroma at the default amount and pushed the opposite
/// hue into its block neighbours.
#[test]
fn an_isolated_hot_pixel_leaves_no_colour_spike_at_the_default_amount() {
    let (w, h, at) = (32, 24, (13, 9));
    let mut img = flat_with_hot_pixel(w, h, at);
    let field = img.pixels[0];
    let spike = chroma_offset(img.pixels[(at.1 * w + at.0) as usize], field);
    run(&mut img, 25.0, (0, 0));
    let worst = img
        .pixels
        .iter()
        .map(|&p| chroma_offset(p, field))
        .fold(0.0f32, f32::max);
    assert!(
        worst < 0.2 * spike,
        "a chroma spike of {spike:.4} still leaves {worst:.4} after chroma NR"
    );
}

/// The clamp ramps in with the amount, so the slider has no step anywhere
/// between identity at 0 and full half-resolution chroma at 100. Two
/// measures: the whole render never moves a pixel by 0.025 per half step
/// (the half-res NLM's own steepest change here is about 0.018, near amount
/// 1–2), and the clamp's own share of the render (clamped minus unclamped)
/// changes by under 0.003 per half step. A clamp applied in full from the
/// first tick jumps 0.04; one ramping in by amount 2.5 instead of 25 steps
/// about ten times further per tick than this ramp does.
#[test]
fn the_hot_pixel_fades_without_a_step_across_the_slider() {
    let source = flat_with_hot_pixel(32, 24, (13, 9));
    let render = |amount: f32, despeckle: bool| {
        let mut img = source.clone();
        if despeckle {
            run(&mut img, amount, (0, 0));
        } else {
            apply_color_half_res_without_despeckle(&mut img, amount, None, 100);
        }
        img.pixels
    };
    let largest_step = |a: &[[f32; 3]], b: &[[f32; 3]]| {
        a.iter()
            .zip(b)
            .flat_map(|(p, q)| p.iter().zip(q).map(|(u, v)| (u - v).abs()))
            .fold(0.0f32, f32::max)
    };
    let clamp_share = |amount: f32| -> Vec<[f32; 3]> {
        render(amount, true)
            .iter()
            .zip(&render(amount, false))
            .map(|(p, q)| [p[0] - q[0], p[1] - q[1], p[2] - q[2]])
            .collect()
    };
    let amounts: Vec<f32> = (0..=200).map(|k| k as f32 * 0.5).collect();
    let (render_step, clamp_step) = amounts
        .windows(2)
        .map(|pair| {
            (
                largest_step(&render(pair[0], true), &render(pair[1], true)),
                largest_step(&clamp_share(pair[0]), &clamp_share(pair[1])),
            )
        })
        .fold((0.0f32, 0.0f32), |(r, c), (dr, dc)| (r.max(dr), c.max(dc)));
    assert!(
        render_step < 0.025,
        "a 0.5 slider step moved a pixel by {render_step:.4}"
    );
    assert!(
        clamp_step < 0.003,
        "a 0.5 slider step moved the clamp's share by {clamp_step:.4}"
    );
}

/// Texture within the margin of its neighbourhood's range passes untouched;
/// only the excess beyond it is pulled in.
#[test]
fn the_clamp_leaves_values_within_the_margin_alone() {
    let range = (0.010, 0.020);
    let inside_margin = range.1 + 0.8 * DESPECKLE_MARGIN;
    let close = |got: f32, want: f32| assert!((got - want).abs() < 1e-7, "{got} != {want}");
    assert_eq!(despeckle(inside_margin, Some(range), 1.0), inside_margin);
    close(
        despeckle(range.0 - 0.1, Some(range), 1.0),
        range.0 - DESPECKLE_MARGIN,
    );
    close(
        despeckle(range.1 + 0.1, Some(range), 0.5),
        0.5 * (range.1 + 0.1) + 0.5 * (range.1 + DESPECKLE_MARGIN),
    );
}

fn flat_with(w: u32, h: u32, at: (u32, u32), bad: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    img.pixels.fill([0.18, 0.16, 0.20]);
    img.pixels[(at.1 * w + at.0) as usize] = [bad, 0.16, 0.20];
    img
}

/// A NaN or infinite sensel poisons its block's chroma and every bilinear
/// tap and NLM patch that reads it (the full-resolution filter before #6018
/// spread one over 7×7 pixels; this one over 12×12, with or without the
/// clamp). The clamp must leave such a neighbourhood alone rather than clamp
/// against an inverted range, which panics; the damage stays inside the
/// reach, and everything beyond it matches the clean frame.
#[test]
fn a_non_finite_pixel_neither_panics_nor_spreads_past_the_reach() {
    let (w, h, at) = (40u32, 40u32, (19u32, 20u32));
    let reach = HALF_RES_CHROMA_REACH_PX as u32;
    let mut clean = flat_with(w, h, at, 0.18);
    run(&mut clean, 25.0, (0, 0));
    for bad in [f32::NAN, f32::INFINITY] {
        let mut img = flat_with(w, h, at, bad);
        run(&mut img, 25.0, (0, 0));
        for r in 0..h {
            for c in 0..w {
                let i = (r * w + c) as usize;
                if c.abs_diff(at.0) > reach || r.abs_diff(at.1) > reach {
                    assert_eq!(img.pixels[i], clean.pixels[i], "{bad}: pixel ({c}, {r})");
                } else if !img.pixels[i].iter().all(|v| v.is_finite()) {
                    assert!(
                        c.abs_diff(at.0) < reach && r.abs_diff(at.1) < reach,
                        "{bad}: non-finite at ({c}, {r})"
                    );
                }
            }
        }
    }
}
