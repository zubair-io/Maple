//! #4123: at a sharp luminance edge AMaZE's directional colour-difference
//! kernel can extrapolate a reconstructed chroma below zero. False-colour
//! suppression must then follow the measured surface chromaticity instead of
//! importing the bright side's sensor mean into the dark side.

use super::{amaze, fcs};
use crate::image::{CfaPattern, ColorSpace, Image};

const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];
const CHROMA: [f32; 3] = [0.46, 1.0, 0.47];
const SIDE: usize = 24;

fn edge_side(direction: usize, x: usize, y: usize) -> bool {
    let (x, y) = (x as isize - 12, y as isize - 12);
    match direction {
        0 => x < 0,
        1 => y < 0,
        _ => x < y,
    }
}

fn sampled(pattern: CfaPattern, i: usize) -> usize {
    pattern.color_at((i % SIDE) as u32, (i / SIDE) as u32) as usize
}

/// Runs FCS on a frame whose reconstructed chroma is `truth` except at the
/// R/B sites `collapse` selects, whose opposite chroma carries `fill` ×
/// green — negative where the AMaZE kernel extrapolated past zero.
fn suppress(
    pattern: CfaPattern,
    truth: &[[f32; 3]],
    collapse: impl Fn(usize) -> bool,
    fill: f32,
) -> Image {
    let cfa_flat: Vec<f32> = truth
        .iter()
        .enumerate()
        .map(|(i, p)| p[sampled(pattern, i)])
        .collect();
    let green: Vec<f32> = truth.iter().map(|p| p[1]).collect();
    let mut image = Image::new(SIDE as u32, SIDE as u32, ColorSpace::CameraNativeLinearRgb);
    image.pixels = truth
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let c = sampled(pattern, i);
            let mut q = *p;
            if collapse(i) && c != 1 {
                for t in [0, 2].into_iter().filter(|&t| t != c) {
                    q[t] = fill * p[1];
                }
            }
            q
        })
        .collect();
    fcs::suppress_false_colour(
        &mut image,
        &cfa_flat,
        &green,
        SIDE,
        SIDE,
        pattern,
        fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
    );
    image
}

fn within(direction: usize, i: usize, reach: usize) -> bool {
    let (x, y) = (i % SIDE, i / SIDE);
    (x.saturating_sub(reach)..=x + reach)
        .flat_map(|nx| (y.saturating_sub(reach)..=y + reach).map(move |ny| (nx, ny)))
        .any(|(nx, ny)| edge_side(direction, nx, ny) != edge_side(direction, x, y))
}

fn near_edge(direction: usize, i: usize) -> bool {
    within(direction, i, 2)
}

#[test]
fn collapsed_chroma_at_a_luminance_edge_follows_the_surface_chromaticity() {
    for pattern in PATTERNS {
        for direction in 0..3 {
            for exposure in [0.01_f32, 1.0, 16.0] {
                // Include a saturated hue whose R/G and B/G ratios differ by
                // far more than the support threshold. They still describe
                // one surface and must not be rejected as unlike channels.
                for chroma in [CHROMA, [0.12, 1.0, 0.85]] {
                    let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                        .map(|i| {
                            let level = if edge_side(direction, i % SIDE, i / SIDE) {
                                0.75
                            } else {
                                0.045
                            };
                            chroma.map(|k| k * level * exposure)
                        })
                        .collect();
                    let out = suppress(pattern, &truth, |i| near_edge(direction, i), -0.5);
                    for (i, (actual, expected)) in out.pixels.iter().zip(&truth).enumerate() {
                        let (x, y) = (i % SIDE, i / SIDE);
                        let c = sampled(pattern, i);
                        if c == 1 || x < 3 || y < 3 || x + 3 >= SIDE || y + 3 >= SIDE {
                            continue;
                        }
                        for t in 0..3 {
                            assert!(
                                (actual[t] - expected[t]).abs() <= 1e-5 * expected[t],
                                "{pattern:?} direction={direction} exposure={exposure} ({x},{y}) \
                                 channel {t}: {actual:?} != {expected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn collapsed_chroma_at_a_colour_edge_keeps_the_existing_value_blend() {
    for pattern in PATTERNS {
        for direction in 0..3 {
            let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                .map(|i| {
                    if edge_side(direction, i % SIDE, i / SIDE) {
                        [0.133, 0.321, 0.114]
                    } else {
                        [0.046, 0.087, 0.396]
                    }
                })
                .collect();
            let collapsed = suppress(pattern, &truth, |i| near_edge(direction, i), -0.5);
            let zero_floor = suppress(pattern, &truth, |i| near_edge(direction, i), 0.0);
            for i in (0..SIDE * SIDE).filter(|&i| within(direction, i, 1)) {
                assert_eq!(
                    collapsed.pixels[i], zero_floor.pixels[i],
                    "{pattern:?} direction={direction} pixel {i}: a colour edge has no \
                     supported hue, so a collapsed estimate takes the zero-floor value blend"
                );
            }
        }
    }
}

#[test]
fn collapsed_chroma_rejects_moderate_colour_edges() {
    for pattern in PATTERNS {
        for direction in 0..3 {
            let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                .map(|i| {
                    let bright = edge_side(direction, i % SIDE, i / SIDE);
                    let level = if bright { 0.75 } else { 0.045 };
                    let (red_ratio, blue_ratio) = if bright { (1.0, 0.5) } else { (0.5, 1.0) };
                    [red_ratio * level, level, blue_ratio * level]
                })
                .collect();
            let collapsed = suppress(pattern, &truth, |i| near_edge(direction, i), -0.5);
            let zero_floor = suppress(pattern, &truth, |i| near_edge(direction, i), 0.0);
            for i in (0..SIDE * SIDE).filter(|&i| within(direction, i, 1)) {
                assert_eq!(
                    collapsed.pixels[i], zero_floor.pixels[i],
                    "{pattern:?} direction={direction} pixel {i}: a 0.5-to-1.0 surface-ratio \
                     change is a colour edge and must reject the collapsed hue estimate"
                );
            }
        }
    }
}

#[test]
fn collapsed_chroma_rejects_diagonals_without_centre_surface_support() {
    for pattern in PATTERNS {
        let centre = (10..14)
            .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
            .find(|&i| sampled(pattern, i) != 1)
            .expect("Bayer tile contains red and blue sites");
        let sampled_channel = sampled(pattern, centre);
        let opposite_channel = 2 - sampled_channel;
        let mut truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
            .map(|_| CHROMA.map(|ratio| ratio * 0.25))
            .collect();
        // The centre's measured colour is a one-pixel feature; its four
        // opposite-colour diagonals remain on the uniform background.
        truth[centre][sampled_channel] = 0.9 * truth[centre][1];
        truth[centre][opposite_channel] = 0.0;

        let out = suppress(pattern, &truth, |i| i == centre, -0.5);
        assert_eq!(
            out.pixels[centre][opposite_channel], 0.0,
            "{pattern:?}: unsupported diagonal hue must not be transported into an isolated feature"
        );
    }
}

#[test]
fn collapsed_chroma_rejects_background_diagonals_around_a_plus_shaped_surface() {
    for pattern in PATTERNS {
        let centre = (10..14)
            .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
            .find(|&i| sampled(pattern, i) != 1)
            .expect("Bayer tile contains red and blue sites");
        let sampled_channel = sampled(pattern, centre);
        let opposite_channel = 2 - sampled_channel;
        let mut truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
            .map(|_| CHROMA.map(|ratio| ratio * 0.25))
            .collect();

        // A one-pixel-wide plus in the sampled-channel lattice belongs to a
        // different surface; the opposite-colour diagonals remain background.
        for support in [
            centre,
            centre - 2,
            centre + 2,
            centre - 2 * SIDE,
            centre + 2 * SIDE,
        ] {
            truth[support][sampled_channel] = 0.9 * truth[support][1];
        }
        truth[centre][opposite_channel] = 0.0;

        let collapsed = suppress(pattern, &truth, |i| i == centre, -0.5);
        let zero_floor = suppress(pattern, &truth, |i| i == centre, 0.0);
        assert_eq!(
            collapsed.pixels[centre][opposite_channel],
            zero_floor.pixels[centre][opposite_channel],
            "{pattern:?}: diagonal background hue must not be transported into a plus-shaped surface"
        );
    }
}

#[test]
fn suppression_never_emits_negative_chroma() {
    let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
        .map(|i| {
            CHROMA.map(|k| {
                k * if edge_side(2, i % SIDE, i / SIDE) {
                    0.75
                } else {
                    0.045
                }
            })
        })
        .collect();
    for pattern in PATTERNS {
        let out = suppress(pattern, &truth, |_| true, -0.5);
        assert!(
            out.pixels.iter().flatten().all(|v| *v >= 0.0),
            "{pattern:?}"
        );
    }
}

#[test]
fn disabled_suppression_and_frame_ring_only_clamp_signed_opposite_chroma() {
    const W: usize = 24;
    const H: usize = 24;
    for pattern in PATTERNS {
        let pixels: Vec<[f32; 3]> = (0..H)
            .flat_map(|y| {
                (0..W).map(
                    move |x| match pattern.color_at(x as u32, y as u32) as usize {
                        0 => [0.2, -0.2, -0.3],
                        2 => [-0.1, -0.2, 0.3],
                        _ => [-0.1, -0.2, -0.3],
                    },
                )
            })
            .collect();
        let expected_pixel = |mut pixel: [f32; 3], x: usize, y: usize| {
            match pattern.color_at(x as u32, y as u32) as usize {
                0 => pixel[2] = 0.0,
                2 => pixel[0] = 0.0,
                _ => {}
            }
            pixel
        };

        let run = |strength: f32| {
            let mut image = Image::new(W as u32, H as u32, ColorSpace::CameraNativeLinearRgb);
            image.pixels.clone_from(&pixels);
            fcs::suppress_false_colour(
                &mut image,
                &vec![0.2; W * H],
                &vec![-0.2; W * H],
                W,
                H,
                pattern,
                strength,
            );
            image
        };

        let disabled = run(0.0);
        for y in 0..H {
            for x in 0..W {
                let i = y * W + x;
                assert_eq!(
                    disabled.pixels[i],
                    expected_pixel(pixels[i], x, y),
                    "disabled {pattern:?} ({x},{y})"
                );
            }
        }

        let enabled = run(1.0);
        for y in 0..H {
            for x in 0..W {
                if x < 3 || y < 3 || x + 3 >= W || y + 3 >= H {
                    let i = y * W + x;
                    assert_eq!(
                        enabled.pixels[i],
                        expected_pixel(pixels[i], x, y),
                        "frame ring {pattern:?} ({x},{y})"
                    );
                }
            }
        }
    }
}

/// Area-sampled axis-aligned edge between two surfaces of the same
/// chromaticity, `bright` on the far side of `split`.
fn step_mosaic(cfa: CfaPattern, size: u32, vertical: bool, split: f32, flip: bool) -> Image {
    let mut img = Image::new(size, size, ColorSpace::CameraNativeMosaic);
    for y in 0..size {
        for x in 0..size {
            let along = if vertical { x } else { y } as f32;
            let lit = (along + 1.0 - split).clamp(0.0, 1.0);
            let lit = if flip { 1.0 - lit } else { lit };
            let level = 0.045 + (0.75 - 0.045) * lit;
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * size + x) as usize][c] = level * CHROMA[c];
        }
    }
    img
}

#[test]
fn amaze_step_between_equal_chromaticity_surfaces_keeps_opposite_chroma_hue() {
    const SIZE: u32 = 48;
    for cfa in PATTERNS {
        for vertical in [true, false] {
            for flip in [false, true] {
                for split in [24.0_f32, 24.4] {
                    let out = amaze(&step_mosaic(cfa, SIZE, vertical, split, flip), cfa);
                    for y in 8..SIZE - 8 {
                        for x in 8..SIZE - 8 {
                            let c = cfa.color_at(x, y) as usize;
                            if c == 1 {
                                continue;
                            }
                            let t = 2 - c;
                            let p = out.pixels[(y * SIZE + x) as usize];
                            let ratio = (p[t] / p[1]) / (CHROMA[t] / CHROMA[1]);
                            assert!(
                                (1.0 / 1.5..=1.5).contains(&ratio),
                                "{cfa:?} vertical={vertical} flip={flip} split={split} \
                                 ({x},{y}) channel {t}: {p:?} is {ratio:.3}x the surface ratio"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[path = "tests_fcs_ceiling.rs"]
mod ceiling;

#[test]
fn positive_chroma_does_not_import_bright_side_values_across_luminance_edges() {
    for pattern in PATTERNS {
        for direction in 0..3 {
            for exposure in [0.01_f32, 1.0, 16.0] {
                let truth: Vec<[f32; 3]> = (0..SIDE * SIDE)
                    .map(|i| {
                        let level = if edge_side(direction, i % SIDE, i / SIDE) {
                            0.75
                        } else {
                            0.045
                        };
                        CHROMA.map(|c| c * level * exposure)
                    })
                    .collect();
                let out = suppress(pattern, &truth, |_| false, 0.0);
                for y in 4..SIDE - 4 {
                    for x in 4..SIDE - 4 {
                        let i = y * SIDE + x;
                        for (actual, expected) in out.pixels[i].iter().zip(truth[i]) {
                            assert!((actual - expected).abs() <= 1e-4 * expected,
                                "{pattern:?} direction={direction} exposure={exposure} ({x},{y}): {:?} != {:?}", out.pixels[i], truth[i]);
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn unsupported_hue_edges_keep_the_nearest_sensor_value_average() {
    for pattern in PATTERNS {
        for exposure in [0.01_f32, 1.0, 16.0] {
            let centre = (10..14)
                .flat_map(|y| (10..14).map(move |x| y * SIDE + x))
                .find(|&i| sampled(pattern, i) != 1)
                .unwrap();
            let target = 2 - sampled(pattern, centre);
            let mut truth = vec![[0.1 * exposure, 0.2 * exposure, 0.3 * exposure]; SIDE * SIDE];
            for offset in [-1_isize, 1, -(SIDE as isize), SIDE as isize] {
                truth[(centre as isize + offset) as usize][1] = 0.8 * exposure;
            }
            let mut expected = 0.0;
            for ((dx, dy), (guide, ratio)) in [(-1_isize, -1_isize), (1, -1), (-1, 1), (1, 1)]
                .into_iter()
                .zip([(0.2, 0.1), (0.8, 0.3), (0.2, 0.6), (0.8, 1.0)])
            {
                let i = (centre as isize + dy * SIDE as isize + dx) as usize;
                truth[i][1] = guide * exposure;
                truth[i][target] = guide * ratio * exposure;
                expected += truth[i][target];
            }
            expected *= 0.25;
            let out = suppress(pattern, &truth, |i| i == centre, 0.0);
            assert!(
                (out.pixels[centre][target] - expected).abs() <= 1e-7 * exposure,
                "{pattern:?} exposure={exposure}: {:?}, expected value fallback {expected}",
                out.pixels[centre]
            );
        }
    }
}
