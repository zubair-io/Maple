//! #4123 measured Canon EOS 5DS R neighbourhood: a selected two-point
//! guide fit is not independent evidence for a luminance interpolation.
use super::*;

#[test]
fn non_affine_pair_requires_independent_sensor_support() {
    let n = 24usize;
    for pattern in [
        CfaPattern::Rggb,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::Bggr,
    ] {
        for channel in [0usize, 2] {
            for rotation in 0..4 {
                for exposure in [0.01f32, 0.1, 1.0, 4.0, 64.0] {
                    let (x, y) = (10..14)
                        .flat_map(|y| (10..14).map(move |x| (x, y)))
                        .find(|&(x, y)| {
                            pattern.color_at(x as u32, y as u32) as usize == 2 - channel
                        })
                        .unwrap();

                    // Actual nearest sensor colour/green pairs at (5123,3361),
                    // plus two independent same-diagonal witnesses. Re-map the
                    // same measured support across every Bayer phase/rotation.
                    for (center, samples) in [
                        (
                            0.01567786,
                            [
                                (-1isize, -1isize, 0.051703911_f32, 0.028716089_f32),
                                (1, -1, 0.011923265, 0.0044585504),
                                (-1, 1, 0.034221914, 0.013980201),
                                (1, 1, 0.012525653, 0.0037784327),
                                (3, -3, 0.013297125, 0.0050630998),
                                (-3, 3, 0.010730349, 0.0037784327),
                                (-3, -3, 0.012, 0.007),
                                (3, 3, 0.012, 0.007),
                            ],
                        ),
                        // Actual test_0018 colour step. Four near samples
                        // repeat two levels; every far witness repeats them.
                        // A two-level affine fit supplies no third guide.
                        (
                            0.087006956,
                            [
                                (-1, -1, 0.08700694, 0.04600595),
                                (1, -1, 0.08700694, 0.04600595),
                                (-1, 1, 0.94900435, 0.94900435),
                                (1, 1, 0.94900435, 0.94900435),
                                (3, -3, 0.08700694, 0.04600595),
                                (-3, 3, 0.94900435, 0.94900435),
                                (-3, -3, 0.08700694, 0.04600595),
                                (3, 3, 0.94900435, 0.94900435),
                            ],
                        ),
                    ] {
                        let mut truth = vec![[0.007, 0.012, 0.009]; n * n];
                        let mean = samples[..4].iter().map(|s| s.3).sum::<f32>() / 4.0;
                        truth[y * n + x][1] = center;
                        truth[y * n + x][channel] = mean;
                        for (mut dx, mut dy, g, c) in samples {
                            for _ in 0..rotation {
                                (dx, dy) = (-dy, dx);
                            }
                            let i = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                            truth[i][1] = g;
                            truth[i][channel] = c;
                        }
                        for p in &mut truth {
                            for v in p {
                                *v *= exposure;
                            }
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
                        image.pixels = truth.clone();
                        fcs::suppress_false_colour(&mut image, &sensor, &green, n, n, pattern, 5.0);
                        assert!((image.pixels[y*n+x][channel]-mean*exposure).abs()<2e-6*exposure,
                        "unsupported pair changed existing sensor mean: {pattern:?} c={channel} r={rotation} e={exposure}: {:?}",image.pixels[y*n+x]);
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
}
