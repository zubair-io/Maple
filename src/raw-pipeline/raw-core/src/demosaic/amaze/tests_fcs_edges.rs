//! #4123 physical-value controls for AMaZE false-colour suppression.
use super::*;

#[test]
fn fcs_preserves_correct_chroma_across_a_pure_luminance_edge() {
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for direction in 0..3 {
            for exposure in [0.1f32, 1.0, 2.0] {
                let truth: Vec<[f32; 3]> = (0..side * side)
                    .map(|i| {
                        let (x, y) = ((i % side) as i32, (i / side) as i32);
                        let distance = match direction {
                            0 => x - 12,
                            1 => y - 12,
                            _ => x - y,
                        };
                        let light = if distance < 0 {
                            0.9 * exposure
                        } else {
                            0.04 * exposure
                        };
                        [0.65 * light, light, 0.4 * light]
                    })
                    .collect();
                let cfa_flat: Vec<f32> = truth
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        p[pattern.color_at((i % side) as u32, (i / side) as u32) as usize]
                    })
                    .collect();
                let green: Vec<f32> = truth.iter().map(|p| p[1]).collect();
                let mut image =
                    Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
                image.pixels = truth.clone();
                fcs::suppress_false_colour(
                    &mut image,
                    &cfa_flat,
                    &green,
                    side,
                    side,
                    pattern,
                    fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                );
                for (i, (actual, expected)) in image.pixels.iter().zip(&truth).enumerate() {
                    let sampled = pattern.color_at((i % side) as u32, (i / side) as u32) as usize;
                    assert_eq!(actual[sampled], expected[sampled]);
                    assert_eq!(actual[1], expected[1]);
                    for c in [0, 2] {
                        assert!((actual[c]-expected[c]).abs()<1e-5,"pattern={pattern:?},direction={direction},exposure={exposure},pixel={i},channel={c},actual={actual:?},truth={expected:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn fcs_retains_value_recovery_where_same_colour_sensor_samples_agree() {
    let side = 24usize;
    let pattern = CfaPattern::Rggb;
    let mut image = Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
    let mut green = vec![0.1; side * side];
    green[12 * side + 12] = 0.9;
    let cfa_flat: Vec<f32> = (0..side * side)
        .map(
            |i| match pattern.color_at((i % side) as u32, (i / side) as u32) {
                0 => 0.1,
                1 => green[i],
                _ => 0.8,
            },
        )
        .collect();
    for (i, p) in image.pixels.iter_mut().enumerate() {
        *p = [0.1, green[i], 0.1];
        let sampled = pattern.color_at((i % side) as u32, (i / side) as u32) as usize;
        p[sampled] = cfa_flat[i];
    }
    fcs::suppress_false_colour(
        &mut image,
        &cfa_flat,
        &green,
        side,
        side,
        pattern,
        fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
    );
    assert!((image.pixels[12 * side + 12][2] - 0.8).abs() < 1e-6);
    assert_eq!(image.pixels[12 * side + 12][0], 0.1);
    assert_eq!(image.pixels[12 * side + 12][1], 0.9);
}

#[test]
fn fcs_preserves_affine_colour_when_green_lies_between_sensor_samples() {
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for exposure in [0.001f32, 0.1, 1.0, 4.0] {
                let (x, y) = (6..side - 6)
                    .flat_map(|y| (6..side - 6).map(move |x| (x, y)))
                    .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == 1)
                    .unwrap();
                let neighbours: Vec<_> = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
                    .into_iter()
                    .filter(|&(nx, ny)| pattern.color_at(nx as u32, ny as u32) as usize == channel)
                    .collect();
                assert_eq!(neighbours.len(), 2);
                let mut green = vec![0.8 * exposure; side * side];
                green[y * side + x] = 0.218 * exposure;
                for ((nx, ny), g) in neighbours.into_iter().zip([0.08, 0.6]) {
                    green[ny * side + nx] = g * exposure;
                }
                // Correct channels include an affine pedestal as well as slope.
                let truth: Vec<[f32; 3]> = green
                    .iter()
                    .map(|&g| [0.7 * g + 0.01 * exposure, g, 0.25 * g + 0.03 * exposure])
                    .collect();
                let cfa: Vec<f32> = truth
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        p[pattern.color_at((i % side) as u32, (i / side) as u32) as usize]
                    })
                    .collect();
                let mut image =
                    Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
                image.pixels = truth.clone();
                fcs::suppress_false_colour(
                    &mut image,
                    &cfa,
                    &green,
                    side,
                    side,
                    pattern,
                    fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                );
                let i = y * side + x;
                assert_eq!(image.pixels[i][1], truth[i][1]);
                assert!(
                    (image.pixels[i][channel] - truth[i][channel]).abs() <= 1e-6 * exposure,
                    "{pattern:?} channel={channel} exposure={exposure} actual={:?} truth={:?}",
                    image.pixels[i],
                    truth[i]
                );
            }
        }
    }
}
#[test]
fn fcs_keeps_hue_when_positive_sensor_ramp_does_not_bracket_green() {
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for exposure in [0.1f32, 1.0, 4.0] {
            let (x, y) = (6..side - 6)
                .flat_map(|y| (6..side - 6).map(move |x| (x, y)))
                .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == 1)
                .unwrap();
            let mut green = vec![0.3 * exposure; side * side];
            green[y * side + x] = exposure;
            for (n, (dx, dy)) in [(-1isize, 0isize), (1, 0), (0, -1), (0, 1)]
                .into_iter()
                .enumerate()
            {
                green[(y as isize + dy) as usize * side + (x as isize + dx) as usize] =
                    (0.2 + 0.1 * n as f32) * exposure;
            }
            let truth: Vec<[f32; 3]> = green.iter().map(|&g| [0.5 * g, g, 0.7 * g]).collect();
            let cfa: Vec<f32> = truth
                .iter()
                .enumerate()
                .map(|(i, p)| p[pattern.color_at((i % side) as u32, (i / side) as u32) as usize])
                .collect();
            let mut image = Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
            image.pixels = truth.clone();
            fcs::suppress_false_colour(
                &mut image,
                &cfa,
                &green,
                side,
                side,
                pattern,
                fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
            );
            assert_eq!(
                image.pixels[y * side + x],
                truth[y * side + x],
                "{pattern:?} exposure={exposure}"
            );
        }
    }
}
#[test]
fn fcs_keeps_value_mean_for_opposing_colour_sensor_evidence() {
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            let (x, y) = (6..side - 6)
                .flat_map(|y| (6..side - 6).map(move |x| (x, y)))
                .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == 1)
                .unwrap();
            let mut green = vec![0.8; side * side];
            green[y * side + x] = 0.05;
            let mut cfa = vec![0.0; side * side];
            let neighbours: Vec<_> = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
                .into_iter()
                .filter(|&(nx, ny)| pattern.color_at(nx as u32, ny as u32) as usize == channel)
                .collect();
            assert_eq!(neighbours.len(), 2);
            for ((nx, ny), (g, c)) in neighbours.into_iter().zip([(0.05, 0.24), (0.34, 0.0)]) {
                green[ny * side + nx] = g;
                cfa[ny * side + nx] = c;
            }
            let mut image = Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
            image.pixels = green.iter().map(|&g| [0.0, g, 0.0]).collect();
            fcs::suppress_false_colour(
                &mut image,
                &cfa,
                &green,
                side,
                side,
                pattern,
                fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
            );
            assert!(
                (image.pixels[y * side + x][channel] - 0.12).abs() < 1e-6,
                "{pattern:?} channel={channel}"
            );
            assert_eq!(image.pixels[y * side + x][1], green[y * side + x]);
        }
    }
}

#[test]
fn fcs_preserves_value_recovery_on_non_affine_colour_edges() {
    // Actual #4123 stage witnesses: a positive two-point fit on a bright
    // green site, and four diagonals crossing a genuine colour boundary.
    // Both were misclassified as luminance ramps by covariance alone.
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for cardinal in [true, false] {
                for exposure in [0.001f32, 0.1, 1.0, 4.0] {
                    let site = if cardinal { 1 } else { 2 - channel as u8 };
                    let (x, y) = (6..side - 6)
                        .flat_map(|y| (6..side - 6).map(move |x| (x, y)))
                        .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == site)
                        .unwrap();
                    let (center_green, hue, support) = if cardinal {
                        (
                            0.99127173,
                            0.760975,
                            [
                                (0.5528338, 0.2563555),
                                (0.17893353, 0.10296945),
                                (0.09680639, 0.05298013),
                                (0.33889943, 0.12881863),
                            ],
                        )
                    } else {
                        (
                            0.06687022,
                            0.13780922,
                            [
                                (0.05799952, 0.48200199),
                                (0.7126284, 0.8119936),
                                (0.30199847, 0.30200657),
                                (0.19045417, 0.18100251),
                            ],
                        )
                    };
                    let mut offsets: Vec<(isize, isize)> = if cardinal {
                        [(-1, 0), (1, 0), (0, -1), (0, 1)]
                            .into_iter()
                            .filter(|&(dx, dy)| {
                                pattern.color_at((x as isize + dx) as u32, (y as isize + dy) as u32)
                                    as usize
                                    == channel
                            })
                            .collect()
                    } else {
                        vec![(-1, -1), (1, -1), (-1, 1), (1, 1)]
                    };
                    if cardinal {
                        let farther: Vec<_> =
                            offsets.iter().map(|&(dx, dy)| (3 * dx, 3 * dy)).collect();
                        offsets.extend(farther);
                    }
                    let mut green =
                        vec![(if cardinal { 0.1 } else { 0.8 }) * exposure; side * side];
                    green[y * side + x] = center_green * exposure;
                    for (&(dx, dy), &(g, _)) in offsets.iter().zip(&support) {
                        green[(y as isize + dy) as usize * side + (x as isize + dx) as usize] =
                            g * exposure;
                    }
                    let mut cfa: Vec<_> = (0..side * side)
                        .map(|i| {
                            if pattern.color_at((i % side) as u32, (i / side) as u32) == 1 {
                                green[i]
                            } else {
                                0.1 * exposure
                            }
                        })
                        .collect();
                    for (&(dx, dy), &(_, c)) in offsets.iter().zip(&support) {
                        cfa[(y as isize + dy) as usize * side + (x as isize + dx) as usize] =
                            c * exposure;
                    }
                    let mut image =
                        Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
                    for (i, p) in image.pixels.iter_mut().enumerate() {
                        *p = [0.1 * exposure, green[i], 0.1 * exposure];
                        p[pattern.color_at((i % side) as u32, (i / side) as u32) as usize] = cfa[i];
                    }
                    image.pixels[y * side + x][channel] = hue * exposure;
                    let before = image.pixels.clone();
                    fcs::suppress_false_colour(
                        &mut image,
                        &cfa,
                        &green,
                        side,
                        side,
                        pattern,
                        fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                    );
                    let count = if cardinal { 2 } else { 4 };
                    let expected = support[..count]
                        .iter()
                        .map(|&(_, c)| c * exposure)
                        .sum::<f32>()
                        / count as f32;
                    assert!((image.pixels[y*side+x][channel]-expected).abs()<=1e-6*exposure,"{pattern:?} channel={channel} cardinal={cardinal} exposure={exposure} actual={} expected={expected}",image.pixels[y*side+x][channel]);
                    for (i, p) in image.pixels.iter().enumerate() {
                        let sampled =
                            pattern.color_at((i % side) as u32, (i / side) as u32) as usize;
                        assert_eq!(p[sampled], before[i][sampled]);
                        assert_eq!(p[1], before[i][1]);
                    }
                }
            }
        }
    }
}

#[test]
fn fcs_recovers_two_level_colour_edges_without_inventing_a_ramp() {
    let side = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for exposure in [0.001f32, 0.1, 1.0, 4.0] {
                let (x, y) = (6..side - 6)
                    .flat_map(|y| (6..side - 6).map(move |x| (x, y)))
                    .find(|&(x, y)| pattern.color_at(x as u32, y as u32) == 1)
                    .unwrap();
                let vertical = pattern.color_at(x as u32, (y - 1) as u32) as usize == channel;
                let truth: Vec<[f32; 3]> = (0..side * side)
                    .map(|i| {
                        let high = if vertical {
                            i / side >= y
                        } else {
                            i % side >= x
                        };
                        let (g, c) = if high {
                            (0.94900435, 0.94900435)
                        } else {
                            (0.08700694, 0.39600214)
                        };
                        let mut p = [0.1 * exposure, g * exposure, 0.1 * exposure];
                        p[channel] = c * exposure;
                        p
                    })
                    .collect();
                let green: Vec<_> = truth.iter().map(|p| p[1]).collect();
                let cfa: Vec<_> = truth
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        p[pattern.color_at((i % side) as u32, (i / side) as u32) as usize]
                    })
                    .collect();
                let mut image =
                    Image::new(side as u32, side as u32, ColorSpace::CameraNativeLinearRgb);
                image.pixels = truth.clone();
                let i = y * side + x;
                let hue = 1.1035019 * exposure;
                image.pixels[i][channel] = hue;
                let target = (0.39600214 + 0.94900435) * 0.5 * exposure;
                let mean = 0.25 * (green[i - 1] + green[i + 1] + green[i - side] + green[i + side]);
                let hf = (green[i] - mean).abs() / (green[i].abs() + mean.abs() + 1e-6);
                let disagreement = (target - hue).abs() / (target.abs() + hue.abs() + 1e-6);
                let alpha = (5.0 * hf * disagreement).clamp(0.0, 1.0);
                let expected = (1.0 - alpha) * hue + alpha * target;
                fcs::suppress_false_colour(
                    &mut image,
                    &cfa,
                    &green,
                    side,
                    side,
                    pattern,
                    fcs::FALSE_COLOUR_SUPPRESS_STRENGTH,
                );
                assert!((image.pixels[i][channel]-expected).abs()<=1e-6*exposure,"{pattern:?} channel={channel} exposure={exposure} actual={} expected={expected}",image.pixels[i][channel]);
                for (i, p) in image.pixels.iter().enumerate() {
                    let c = pattern.color_at((i % side) as u32, (i / side) as u32) as usize;
                    assert_eq!(p[c], truth[i][c]);
                    assert_eq!(p[1], green[i]);
                }
            }
        }
    }
}

#[test]
fn chroma_assembly_preserves_rotated_sensor_evidence() {
    let side = scratch::TS;
    for (pattern, rotated_pattern) in [
        (CfaPattern::Rggb, CfaPattern::Bggr),
        (CfaPattern::Grbg, CfaPattern::Gbrg),
        (CfaPattern::Gbrg, CfaPattern::Grbg),
        (CfaPattern::Bggr, CfaPattern::Rggb),
    ] {
        for exposure in [0.001f32, 0.1, 1.0, 4.0] {
            let render = |rotated: bool| {
                let cfa = if rotated { rotated_pattern } else { pattern };
                let mut s = scratch::Scratch::new();
                for y in 0..side {
                    for x in 0..side {
                        let (sx, sy) = if rotated {
                            (side - 1 - x, side - 1 - y)
                        } else {
                            (x, y)
                        };
                        let rgb = [
                            (0.8 + ((sx * sx + 3 * sy) % 23) as f32 * 0.03) * exposure,
                            0.75 * exposure,
                            (0.4 + ((sx + sy * sy) % 19) as f32 * 0.02) * exposure,
                        ];
                        let i = y * side + x;
                        let c = cfa.color_at(x as u32, y as u32) as usize;
                        s.cfa[i] = rgb[c];
                        s.rgbgreen[i] = rgb[1];
                        s.hvwt[i >> 1] = 0.5;
                        if c != 1 {
                            s.dgrb0[i >> 1] = rgb[1] - rgb[c];
                        }
                    }
                }
                let t = scratch::Tile {
                    top: 0,
                    left: 0,
                    rr1: side,
                    cc1: side,
                };
                let mut out = vec![[0.0; 3]; side * (side - 32)];
                assemble::finish_tile(&mut out, side, &mut s, &t, cfa);
                out
            };
            let original = render(false);
            let rotated = render(true);
            for y in 24..side - 24 {
                for x in 24..side - 24 {
                    let a = original[(y - 16) * side + x];
                    let b = rotated[(side - 1 - y - 16) * side + side - 1 - x];
                    let sampled = pattern.color_at(x as u32, y as u32) as usize;
                    let truth = [
                        (0.8 + ((x * x + 3 * y) % 23) as f32 * 0.03) * exposure,
                        0.75 * exposure,
                        (0.4 + ((x + y * y) % 19) as f32 * 0.02) * exposure,
                    ];
                    assert_eq!(a[sampled], truth[sampled]);
                    assert_eq!(b[sampled], truth[sampled]);
                    assert_eq!(a[1], truth[1]);
                    assert_eq!(b[1], truth[1]);
                    for c in [0, 2] {
                        assert!((a[c]-b[c]).abs()<=2e-6*exposure,
                            "{pattern:?} exposure={exposure} x={x} y={y} channel={c} original={a:?} rotated={b:?}");
                    }
                }
            }
        }
    }
}
