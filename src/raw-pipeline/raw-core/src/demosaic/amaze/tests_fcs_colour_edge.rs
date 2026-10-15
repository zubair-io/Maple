//! A ratio bound is only meaningful on one supported surface. At a colour
//! boundary, preserve FCS's independently computed value-domain correction.
use super::fcs;
use crate::image::{CfaPattern, ColorSpace, Image};

const SIDE: usize = 24;
const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];

fn run(pattern: CfaPattern, truth: &[[f32; 3]]) -> Image {
    let cfa: Vec<_> = truth
        .iter()
        .enumerate()
        .map(|(i, p)| p[pattern.color_at((i % SIDE) as u32, (i / SIDE) as u32) as usize])
        .collect();
    let green: Vec<_> = truth.iter().map(|p| p[1]).collect();
    let mut out = Image::new(SIDE as u32, SIDE as u32, ColorSpace::CameraNativeLinearRgb);
    out.pixels = truth.to_vec();
    fcs::suppress_false_colour(
        &mut out,
        &cfa,
        &green,
        SIDE,
        SIDE,
        pattern,
        fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
    );
    out
}

// The unchanged FCS equation, evaluated directly from the synthetic scene.
// This deliberately does not call the production ratio/support helpers.
fn value_blend(
    pattern: CfaPattern,
    truth: &[[f32; 3]],
    x: usize,
    y: usize,
    t: usize,
) -> (f32, f32) {
    let near: Vec<_> = (-1_isize..=1)
        .flat_map(|dy| (-1_isize..=1).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| {
            (dx != 0 || dy != 0)
                && pattern.color_at((x as isize + dx) as u32, (y as isize + dy) as u32) as usize
                    == t
        })
        .map(|(dx, dy)| truth[(y as isize + dy) as usize * SIDE + (x as isize + dx) as usize])
        .collect();
    let ratios: Vec<_> = near.iter().map(|p| p[t] / p[1]).collect();
    let lo = ratios.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = ratios.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let spread = (hi - lo) / (ratios.iter().sum::<f32>() / ratios.len() as f32);
    let value = near.iter().map(|p| p[t]).sum::<f32>() / near.len() as f32;
    let i = y * SIDE + x;
    let hue = truth[i][t];
    let green = truth[i][1];
    let mean = (truth[i - 1][1] + truth[i + 1][1] + truth[i - SIDE][1] + truth[i + SIDE][1]) * 0.25;
    let edge = ((green - mean).abs() / (green.abs() + mean.abs() + 1e-6)).min(1.0);
    let disagreement = ((value - hue).abs() / (value.abs() + hue.abs() + 1e-6)).min(1.0);
    let alpha = (fcs::FALSE_COLOUR_SUPPRESS_STRENGTH * edge * disagreement).clamp(0.0, 1.0);
    ((1.0 - alpha) * hue + alpha * value, spread)
}

#[test]
fn positive_colour_edges_preserve_the_value_domain_correction() {
    for pattern in PATTERNS {
        for direction in 0..3 {
            for exposure in [0.01_f32, 1.0, 16.0] {
                let truth: Vec<_> = (0..SIDE * SIDE)
                    .map(|i| {
                        let (x, y) = (i % SIDE, i / SIDE);
                        let bright = match direction {
                            0 => x < 12,
                            1 => y < 12,
                            _ => x < y,
                        };
                        if bright {
                            [0.75 * exposure, 0.75 * exposure, 0.375 * exposure]
                        } else {
                            [0.0225 * exposure, 0.045 * exposure, 0.045 * exposure]
                        }
                    })
                    .collect();
                let out = run(pattern, &truth);
                let mut witnesses = 0;
                for y in 3..SIDE - 3 {
                    for x in 3..SIDE - 3 {
                        let sampled = pattern.color_at(x as u32, y as u32) as usize;
                        for t in [0, 2].into_iter().filter(|&t| t != sampled) {
                            let (expected, spread) = value_blend(pattern, &truth, x, y, t);
                            if spread < 0.2
                                || (expected - truth[y * SIDE + x][t]).abs() < 1e-6 * exposure
                            {
                                continue;
                            }
                            witnesses += 1;
                            assert!((out.pixels[y*SIDE+x][t]-expected).abs()<=1e-6*exposure,
                          "{pattern:?} direction={direction} exposure={exposure} ({x},{y}) channel={t}: {} != {expected}",out.pixels[y*SIDE+x][t]);
                        }
                    }
                }
                assert!(
                    witnesses > 0,
                    "each Bayer phase and edge must exercise the correction"
                );
            }
        }
    }
}

#[test]
fn positive_bound_rejects_background_ratios_around_an_isolated_colour() {
    for pattern in PATTERNS {
        for exposure in [0.01_f32, 1.0, 16.0] {
            let centre = (10..14)
                .flat_map(|y| (10..14).map(move |x| (x, y)))
                .find(|&(x, y)| pattern.color_at(x as u32, y as u32) != 1)
                .unwrap();
            let (x, y) = centre;
            let sampled = pattern.color_at(x as u32, y as u32) as usize;
            let target = 2 - sampled;
            let mut truth = vec![[0.5 * exposure; 3]; SIDE * SIDE];
            truth[y * SIDE + x] = [0.02 * exposure; 3];
            truth[y * SIDE + x][sampled] = 0.04 * exposure;
            let (expected, spread) = value_blend(pattern, &truth, x, y, target);
            assert_eq!(
                spread, 0.0,
                "background target ratios alone falsely imply a uniform surface"
            );
            let out = run(pattern, &truth);
            assert!(
                (out.pixels[y * SIDE + x][target] - expected).abs() <= 1e-6 * exposure,
                "{pattern:?} exposure={exposure}: centre colour rejects the background bound"
            );
        }
    }
}
