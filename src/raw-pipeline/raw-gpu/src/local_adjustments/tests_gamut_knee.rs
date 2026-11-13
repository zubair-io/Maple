//! #4664: local hue, saturation and vibrance near the Rec.2020 hull, where
//! the soft knee engages before the target leaves gamut, and just past it,
//! where an out-of-gamut input keeps the full shoulder.

use super::tests::{max_abs_diff, only, raw_core_local, run_gpu};
use super::*;
use raw_core::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, Point2};

fn hull_chroma(l: f32, cos: f32, sin: f32) -> f32 {
    (0..40)
        .fold((0.0_f32, 2.0_f32), |(lo, hi), _| {
            let mid = 0.5 * (lo + hi);
            let rgb = oklab_to_rec2020([l, mid * cos, mid * sin]);
            if rgb.iter().all(|v| *v >= 0.0) {
                (mid, hi)
            } else {
                (lo, mid)
            }
        })
        .0
}

fn near_hull_buffer() -> (Vec<f32>, u32, u32) {
    let (w, h) = (24u32, 16u32);
    let pixels: Vec<f32> = (0..w * h)
        .flat_map(|i| {
            let hue = (i % w) as f32 * 15.0;
            let l = [0.35, 0.55, 0.75, 1.25][(i / w % 4) as usize];
            let fraction = [0.82, 0.93, 0.99, 1.15][(i / w / 4) as usize];
            let (sin, cos) = hue.to_radians().sin_cos();
            let c = fraction * hull_chroma(l, cos, sin);
            let rgb = oklab_to_rec2020([l, c * cos, c * sin]);
            [rgb[0], rgb[1], rgb[2], 1.0]
        })
        .collect();
    (pixels, w, h)
}

fn feathered(adjustments: PartialAdjustments) -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 1.0,
        },
        range: None,
        adjustments,
    }
}

#[test]
fn near_hull_knee_matches_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = near_hull_buffer();
    assert!(input
        .chunks_exact(4)
        .all(|p| rec2020_to_oklab([p[0], p[1], p[2]])[0] > 0.0));
    let cases: Vec<(&str, PartialAdjustments)> = vec![
        ("hue+", only(|a| a.hue = Some(35.0))),
        ("hue-", only(|a| a.hue = Some(-80.0))),
        ("saturation+", only(|a| a.saturation = Some(60.0))),
        ("vibrance+", only(|a| a.vibrance = Some(90.0))),
    ];
    for (name, adjustments) in cases {
        let layers = [feathered(adjustments)];
        let cpu = raw_core_local(&input, w, h, &layers, &[]);
        let gpu = run_gpu(&ctx, &input, w, h, &layers, &[]);
        let diff = max_abs_diff(&cpu, &gpu);
        assert!(diff < 1e-4, "{name}: max |cpu - gpu| = {diff}");
    }
}
