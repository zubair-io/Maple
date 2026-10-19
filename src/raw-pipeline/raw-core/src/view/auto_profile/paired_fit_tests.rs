use super::*;
use crate::view::auto_profile::preview::JpegColorSpace;

#[test]
fn basis_matches_the_artifact_sampler() {
    let mut lut = ColorLut::identity(GRID);
    for (i, v) in lut.data.iter_mut().enumerate() {
        *v = ((i * 37) % 101) as f32 / 100.;
    }
    let mut fine = ColorLut::identity(33);
    for node in fine.data.chunks_exact_mut(3) {
        node.copy_from_slice(&lut.sample([node[0], node[1], node[2]]));
    }
    for i in 0..1000 {
        let rgb = [
            ((i * 13) % 997) as f32 / 996.,
            ((i * 29) % 991) as f32 / 990.,
            ((i * 53) % 983) as f32 / 982.,
        ];
        let actual = lut.sample(rgb);
        for c in 0..3 {
            let expected: f64 = corners(rgb)
                .into_iter()
                .map(|(j, w)| w * f64::from(lut.data[j * 3 + c]))
                .sum();
            assert!((f64::from(actual[c]) - expected).abs() < 2e-6);
            assert!((fine.sample(rgb)[c] - actual[c]).abs() < 2e-6);
        }
    }
}

fn preview(image: image::RgbImage) -> ExtractedPreview {
    ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image),
        color_space: JpegColorSpace::SRgb,
    }
}

#[test]
fn identity_observations_preserve_identity() {
    let image = image::RgbImage::from_fn(64, 64, |x, y| {
        image::Rgb([(x * 4) as u8, (y * 4) as u8, ((x * 7 + y * 3) % 256) as u8])
    });
    let pixels: Vec<_> = image.as_raw().iter().map(|v| *v as f32 / 255.).collect();
    let target = preview(image);
    let base = ColorLut::identity(33);
    let observations =
        paired_observations::build(&pixels, 64, 64, ExifOrientation::Normal, &target, &base)
            .unwrap();
    for row in &observations {
        assert!((row.weights.iter().map(|(_, w)| w).sum::<f64>() - 1.).abs() < 1e-12);
        for c in 0..3 {
            assert!((row.source[c] - row.target[c]).abs() < 1e-6);
        }
    }
    let (result, _) = solve_observations(&observations, 33).unwrap();
    for (a, b) in result.data.iter().zip(&base.data) {
        assert!((a - b).abs() < 1e-5);
    }
}

#[test]
fn equal_mean_footprints_need_different_eval_then_box_predictions() {
    let mut pixels = vec![0.; 512 * 512 * 3];
    let target = image::RgbImage::from_fn(256, 256, |x, y| {
        let levels = if (x + y) % 2 == 0 {
            [0., 1.]
        } else {
            [0.5, 0.5]
        };
        for dy in 0..2 {
            for (dx, v) in levels.into_iter().enumerate() {
                let i = ((y as usize * 2 + dy) * 512 + x as usize * 2 + dx) * 3;
                pixels[i..i + 3].fill(v);
            }
        }
        image::Rgb([if (x + y) % 2 == 0 { 128 } else { 64 }; 3])
    });
    let target = preview(target);
    let base = ColorLut::identity(33);
    let observations =
        paired_observations::build(&pixels, 512, 512, ExifOrientation::Normal, &target, &base)
            .unwrap();
    assert!(observations
        .iter()
        .all(|row| (row.source[0] - 0.5).abs() < 1e-8));
    assert!(observations
        .iter()
        .any(|row| row.validation && row.target[0] < 0.3));
    assert!(observations
        .iter()
        .any(|row| row.validation && row.target[0] > 0.4));
    let (_, coarse) = solve_observations(&observations, 33).unwrap();
    assert!(prefer(&coarse, &observations, &observations));
    for row in observations.iter().step_by(31) {
        let predicted: f64 = row
            .weights
            .iter()
            .map(|&(i, w)| w * f64::from(coarse.data[i * 3]))
            .sum();
        assert!((predicted - row.target[0]).abs() < 0.01);
    }
}

#[test]
fn rejects_invalid_pixels_and_geometry() {
    let target = preview(image::RgbImage::new(32, 32));
    let base = ColorLut::identity(33);
    assert!(
        paired_observations::build(&[], 0, 32, ExifOrientation::Normal, &target, &base).is_none()
    );
    let mut pixels = vec![0.5; 32 * 32 * 3];
    pixels[0] = f32::NAN;
    assert!(
        paired_observations::build(&pixels, 32, 32, ExifOrientation::Normal, &target, &base)
            .is_none()
    );
}

#[test]
fn rotated_pixel_footprints_stay_aligned_with_the_preview() {
    let target = image::RgbImage::from_fn(32, 16, |x, y| {
        image::Rgb([(x * 7) as u8, (y * 13) as u8, ((x * 3 + y * 5) % 256) as u8])
    });
    let source = image::imageops::resize(&target, 64, 32, image::imageops::FilterType::Nearest);
    let pixels: Vec<_> = source.as_raw().iter().map(|v| *v as f32 / 255.).collect();
    let observations = paired_observations::build(
        &pixels,
        64,
        32,
        ExifOrientation::Rotate90,
        &preview(target),
        &ColorLut::identity(33),
    )
    .unwrap();
    for row in observations {
        for c in 0..3 {
            assert!((row.source[c] - row.target[c]).abs() < 1e-6);
        }
    }
}

#[test]
fn rejects_local_color_damage_even_when_global_errors_improve() {
    let mut observations = Vec::new();
    for region in 0..64 {
        let (input, target, baseline) = if region == 0 {
            (0.4, 0.2, 0.2)
        } else {
            (0.5, 0.5, 0.8)
        };
        for _ in 0..64 {
            observations.push(Observation {
                weights: corners([input; 3]).to_vec(),
                source: [input as f64; 3],
                target: [target; 3],
                baseline: [baseline; 3],
                validation: true,
                region,
            });
        }
    }
    let old_squared: f64 = observations
        .iter()
        .map(|row| (row.baseline[0] - row.target[0]).powi(2))
        .sum();
    let new_squared: f64 = observations
        .iter()
        .map(|row| (row.source[0] - row.target[0]).powi(2))
        .sum();
    assert!(new_squared < old_squared);
    assert!(!prefer(
        &ColorLut::identity(GRID),
        &observations,
        &observations
    ));
}

#[test]
fn regional_perception_uses_display_averages_and_keeps_native_rgb_checks() {
    let mut native = Vec::new();
    let mut display = Vec::new();
    for region in 0..64 {
        for i in 0..64 {
            if region == 0 {
                let (input, target, baseline) = if i % 2 == 0 {
                    (0.4, 0.38, 0.38)
                } else {
                    (0.6, 0.62, 0.66)
                };
                native.push(Observation {
                    weights: corners([input; 3]).to_vec(),
                    source: [input as f64; 3],
                    target: [target; 3],
                    baseline: [baseline; 3],
                    validation: true,
                    region,
                });
                let weights: Vec<_> = corners([0.4; 3])
                    .into_iter()
                    .chain(corners([0.6; 3]))
                    .map(|(j, w)| (j, w * 0.5))
                    .collect();
                display.push(Observation {
                    weights,
                    source: [0.5; 3],
                    target: [0.5; 3],
                    baseline: [0.52; 3],
                    validation: true,
                    region,
                });
            } else {
                let input = [0.5, 0.3, 0.7];
                for rows in [&mut native, &mut display] {
                    rows.push(Observation {
                        weights: corners(input).to_vec(),
                        source: input.map(f64::from),
                        target: input.map(f64::from),
                        baseline: [0.8, 0.6, 0.95],
                        validation: true,
                        region,
                    });
                }
            }
        }
    }
    let candidate = ColorLut::identity(GRID);
    assert!(!prefer(&candidate, &native, &native));
    assert!(prefer(&candidate, &native, &display));
}
