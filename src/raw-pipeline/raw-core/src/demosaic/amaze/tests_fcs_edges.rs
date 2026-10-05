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
