//! Prints Oklab hue / chroma / lightness percentiles for the pixels inside a
//! normalized rectangle of an sRGB PNG — used once to pin `SKIN_TONE_RANGE`
//! against the ACR baselines of test_0002 / test_0003 (spec §5.2).
//!
//! The PNG is decoded as sRGB-gamma, sRGB-primaries (ACR's `down/` renders),
//! then rotated into Rec.2020 primaries before the Oklab conversion — the
//! same space `stages::local_adjustments::range::weight` evaluates in, so
//! the printed numbers are directly comparable to the runtime gate.
//!
//! Usage: cargo run --release -p raw-core --example skin-range-probe -- <png> <x0> <y0> <x1> <y1>

use raw_core::color::matrices::M_SRGB_TO_REC2020;
use raw_core::color::oklab::rec2020_to_oklab;

fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn percentile(sorted: &[f32], p: f32) -> f32 {
    let i = ((sorted.len() - 1) as f32 * p).round() as usize;
    sorted[i]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 {
        eprintln!("usage: skin-range-probe <png> <x0> <y0> <x1> <y1> (normalized [0,1])");
        std::process::exit(2);
    }
    let img = image::open(&args[1])
        .unwrap_or_else(|e| panic!("failed to open {}: {e}", args[1]))
        .into_rgb8();
    let (w, h) = (img.width(), img.height());
    let rect: Vec<f32> = args[2..6].iter().map(|s| s.parse().unwrap()).collect();

    let (mut hues, mut chromas, mut ls) = (Vec::new(), Vec::new(), Vec::new());
    for y in 0..h {
        for x in 0..w {
            let (nx, ny) = (x as f32 / w as f32, y as f32 / h as f32);
            if nx < rect[0] || nx > rect[2] || ny < rect[1] || ny > rect[3] {
                continue;
            }
            let px = img.get_pixel(x, y);
            let srgb_lin = [
                srgb_decode(px[0] as f32 / 255.0),
                srgb_decode(px[1] as f32 / 255.0),
                srgb_decode(px[2] as f32 / 255.0),
            ];
            let rec2020 = M_SRGB_TO_REC2020.mul_vec(srgb_lin);
            let lab = rec2020_to_oklab(rec2020);
            let c = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            if c < 0.01 {
                continue;
            }
            hues.push(lab[2].atan2(lab[1]).to_degrees());
            chromas.push(c);
            ls.push(lab[0]);
        }
    }
    if hues.is_empty() {
        eprintln!("no pixels with chroma >= 0.01 inside the rectangle");
        std::process::exit(1);
    }
    for v in [&mut hues, &mut chromas, &mut ls] {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    }
    for (name, v) in [("hue_deg", &hues), ("chroma", &chromas), ("L", &ls)] {
        println!(
            "{name}: n={} p5={:.3} p50={:.3} p95={:.3}",
            v.len(),
            percentile(v, 0.05),
            percentile(v, 0.5),
            percentile(v, 0.95)
        );
    }
}
