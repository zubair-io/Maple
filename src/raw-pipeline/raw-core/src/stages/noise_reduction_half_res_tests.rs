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

/// A window cut from the frame at an odd origin, denoised on its own,
/// matches the whole-frame result once the reach band is discarded.
#[test]
fn window_matches_the_frame_inside_the_reach() {
    let (fw, fh) = (96u32, 80u32);
    let mut frame = noisy(fw, fh, 4);
    let source = frame.clone();
    run(&mut frame, 40.0, (0, 0));

    let (ox, oy, ww, wh) = (21u32, 15u32, 50u32, 44u32);
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
                assert_eq!(got, want, "pixel ({c}, {r})");
            } else {
                band_differs |= got != want;
            }
        }
    }
    assert!(
        band_differs,
        "the edge band never differs, so the reach is untested"
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
/// between identity at 0 and full half-resolution chroma at 100. The half-res
/// NLM's own steepest change on this frame is about 0.018 per half step (near
/// amount 1–2, with or without the clamp); a clamp applied in full from the
/// first tick jumps 0.04 between 0 and 0.5.
#[test]
fn the_hot_pixel_fades_without_a_step_across_the_slider() {
    let source = flat_with_hot_pixel(32, 24, (13, 9));
    let render = |amount: f32| {
        let mut img = source.clone();
        run(&mut img, amount, (0, 0));
        img.pixels
    };
    let steps: Vec<f32> = (0..=200).map(|k| k as f32 * 0.5).collect();
    let largest_step = steps
        .windows(2)
        .map(|pair| {
            render(pair[0])
                .iter()
                .zip(&render(pair[1]))
                .flat_map(|(a, b)| a.iter().zip(b).map(|(u, v)| (u - v).abs()))
                .fold(0.0f32, f32::max)
        })
        .fold(0.0f32, f32::max);
    assert!(
        largest_step < 0.025,
        "a 0.5 slider step moved a pixel by {largest_step:.4}"
    );
}
