use super::*;
#[test]
fn fcs_does_not_import_bright_foreground_into_supported_luminance_junction() {
    let n = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for rotation in 0..4 {
                for (witnesses, expected) in [
                    ([(0.02, 0.006), (0.4, 0.14)], 0.08),
                    ([(0.4, 0.14), (0.02, 0.006)], 0.08),
                    ([(0.02, 0.14), (0.4, 0.006)], 0.245),
                    ([(0.02, f32::NAN), (0.4, 0.14)], 0.245),
                    ([(0.02, 0.006), (0.04, 0.014)], 0.245),
                ] {
                    for exposure in [0.01f32, 0.1, 1.0, 4.0, 64.0] {
                        let (x, y) = (10..14)
                            .flat_map(|y| (10..14).map(move |x| (x, y)))
                            .find(|&(x, y)| {
                                pattern.color_at(x as u32, y as u32) as usize == 2 - channel
                            })
                            .unwrap();
                        let mut truth =
                            vec![[0.013 * exposure, 0.02 * exposure, 0.008 * exposure]; n * n];
                        truth[y * n + x] = [0.13 * exposure, 0.2 * exposure, 0.08 * exposure];
                        truth[y * n + x][channel] = expected * exposure;
                        for (mut dx, mut dy, g, c) in [
                            (-1isize, -1isize, 1.0, 0.8),
                            (1, -1, 0.1, 0.04),
                            (-1, 1, 0.3, 0.12),
                            (1, 1, 0.05, 0.02),
                        ] {
                            for _ in 0..rotation {
                                (dx, dy) = (-dy, dx);
                            }
                            let j = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                            truth[j] = [0.65 * g * exposure, g * exposure, 0.4 * g * exposure];
                            truth[j][channel] = c * exposure;
                        }
                        // Independent same-diagonal witnesses preserve the
                        // directional crossing even when the more distant colour
                        // response curves away from the nearest local relation.
                        for (mut dx, mut dy, g, c) in [
                            (3isize, -3isize, witnesses[0].0, witnesses[0].1),
                            (-3, 3, witnesses[1].0, witnesses[1].1),
                        ] {
                            for _ in 0..rotation {
                                (dx, dy) = (-dy, dx);
                            }
                            let j = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                            truth[j][1] = g * exposure;
                            truth[j][channel] = c * exposure;
                        }
                        let sensor: Vec<_> = truth
                            .iter()
                            .enumerate()
                            .map(|(i, p)| {
                                p[pattern.color_at((i % n) as u32, (i / n) as u32) as usize]
                            })
                            .collect();
                        let green: Vec<_> = truth.iter().map(|p| p[1]).collect();
                        let mut image =
                            Image::new(n as u32, n as u32, ColorSpace::CameraNativeLinearRgb);
                        image.pixels = truth;
                        fcs::suppress_false_colour(&mut image, &sensor, &green, n, n, pattern, 5.0);
                        let actual = image.pixels[y * n + x][channel];
                        assert!(
                        (actual - expected * exposure).abs() < 2e-6 * exposure,
                        "{pattern:?} c={channel} rotation={rotation} e={exposure} actual={actual}"
                    );
                        for (i, p) in image.pixels.iter().enumerate() {
                            assert_eq!(p[1], green[i]);
                            assert_eq!(
                                p[pattern.color_at((i % n) as u32, (i / n) as u32) as usize]
                                    .to_bits(),
                                sensor[i].to_bits()
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn unsupported_colour_junction_retains_sensor_value_correction() {
    let n = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for rotation in 0..4 {
                for exposure in [0.01f32, 0.1, 1.0, 4.0] {
                    let (x, y) = (10..14)
                        .flat_map(|y| (10..14).map(move |x| (x, y)))
                        .find(|&(x, y)| {
                            pattern.color_at(x as u32, y as u32) as usize == 2 - channel
                        })
                        .unwrap();
                    let mut truth =
                        vec![[0.02 * exposure, 0.26 * exposure, 0.18 * exposure]; n * n];
                    truth[y * n + x][1] = 0.2 * exposure;
                    truth[y * n + x][channel] = 0.02 * exposure;
                    // Non-affine chromaticities across a luminance minimum: no
                    // diagonal pair brackets the centre. This is not evidence
                    // for affine extrapolation; retain the original sensor mean.
                    for (mut dx, mut dy, g, c) in [
                        (-1isize, -1isize, 0.35, 0.18),
                        (1, -1, 0.42, 0.19),
                        (-1, 1, 0.21, 0.11),
                        (1, 1, 0.34, 0.14),
                    ] {
                        for _ in 0..rotation {
                            (dx, dy) = (-dy, dx);
                        }
                        let i = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                        truth[i][1] = g * exposure;
                        truth[i][channel] = c * exposure;
                    }
                    let sensor: Vec<_> = truth
                        .iter()
                        .enumerate()
                        .map(|(i, p)| p[pattern.color_at((i % n) as u32, (i / n) as u32) as usize])
                        .collect();
                    let green: Vec<_> = truth.iter().map(|p| p[1]).collect();
                    let mut image =
                        Image::new(n as u32, n as u32, ColorSpace::CameraNativeLinearRgb);
                    image.pixels = truth;
                    fcs::suppress_false_colour(&mut image, &sensor, &green, n, n, pattern, 5.0);
                    assert!(image.pixels[y*n+x][channel]>0.08*exposure,"{pattern:?} channel={channel} rotation={rotation} exposure={exposure}: {:?}",image.pixels[y*n+x]);
                    assert!(image.pixels[y * n + x][channel] < 0.155 * exposure);
                    for (i, p) in image.pixels.iter().enumerate() {
                        assert_eq!(p[1], green[i]);
                        assert_eq!(
                            p[pattern.color_at((i % n) as u32, (i / n) as u32) as usize],
                            sensor[i]
                        );
                    }
                }
            }
        }
    }
}
