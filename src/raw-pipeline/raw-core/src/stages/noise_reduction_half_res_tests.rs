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
    for r in reach..wh - reach {
        for c in reach..ww - reach {
            let got = window.pixels[(r * ww + c) as usize];
            let want = frame.pixels[((r + oy) * fw + c + ox) as usize];
            assert_eq!(got, want, "pixel ({c}, {r})");
        }
    }
}
