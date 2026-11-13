use super::*;
use crate::view::auto_profile::preview::JpegColorSpace;

fn rows() -> Vec<Observation> {
    (0..64)
        .flat_map(|region| {
            (0..80).map(move |i| {
                let source = [0.2 + (i % 11) as f32 * 0.04; 3];
                Observation {
                    weights: corners(source).to_vec(),
                    artifact_weights: corners_at(source, 33).to_vec(),
                    source: source.map(f64::from),
                    target: source.map(|v| f64::from(v) + 0.02),
                    baseline: source.map(f64::from),
                    population: 1 + i % 4,
                    validation: i % 5 == 0,
                    in_bias_region: i % 3 != 0,
                    region,
                }
            })
        })
        .collect()
}

fn expand(rows: &[Observation]) -> Vec<Observation> {
    rows.iter()
        .flat_map(|r| {
            (0..r.population).map(move |_| Observation {
                weights: r.weights.clone(),
                artifact_weights: r.artifact_weights.clone(),
                source: r.source,
                target: r.target,
                baseline: r.baseline,
                population: 1,
                validation: r.validation,
                in_bias_region: r.in_bias_region,
                region: r.region,
            })
        })
        .collect()
}

#[test]
fn weighted_fit_matches_explicit_repetition_including_projection_confidence() {
    let weighted = rows();
    let expanded = expand(&weighted);
    let prior = ColorLut::identity(33);
    let (actual, actual_coarse) = solve_observations(&weighted, &prior).unwrap();
    let (expected, expected_coarse) = solve_observations(&expanded, &prior).unwrap();
    for (a, b) in actual
        .data
        .iter()
        .zip(expected.data)
        .chain(actual_coarse.data.iter().zip(expected_coarse.data))
    {
        assert!((*a - b).abs() < 2e-6, "{a} != {b}");
    }
}

#[test]
fn weighted_assessment_matches_explicit_population_without_weakening_sample_coverage() {
    let weighted = rows();
    let expanded = expand(&weighted);
    let candidate = ColorLut {
        size: 33,
        data: ColorLut::identity(33)
            .data
            .iter()
            .map(|v| v + 0.02)
            .collect(),
    };
    let a = assess(&candidate, &weighted, &weighted);
    let b = assess(&candidate, &expanded, &expanded);
    assert!(a.compatible && a.native_bands_preserved);
    assert_eq!(a.compatible, b.compatible);
    assert_eq!(a.native_bands_preserved, b.native_bands_preserved);
    let sparse: Vec<_> = weighted
        .into_iter()
        .step_by(80)
        .map(|mut row| {
            row.population = 10_000;
            row
        })
        .collect();
    assert!(!assess(&candidate, &sparse, &sparse).compatible);
}

#[test]
fn observation_populations_cover_the_entire_native_and_display_target() {
    let pixels = vec![0.4; 64 * 64 * 3];
    let prior = ColorLut::identity(33);
    for (width, height, display, expected) in
        [(413, 307, false, 413 * 307), (1321, 913, true, 1024 * 708)]
    {
        let preview = ExtractedPreview {
            image: image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                width,
                height,
                image::Rgb([102; 3]),
            )),
            color_space: JpegColorSpace::SRgb,
        };
        let set = if display {
            paired_observations::build_display(
                &pixels,
                64,
                64,
                ExifOrientation::Normal,
                &preview,
                &prior,
            )
        } else {
            paired_observations::build(&pixels, 64, 64, ExifOrientation::Normal, &preview, &prior)
        }
        .unwrap();
        assert_eq!(
            set.rows.iter().map(|r| r.population).sum::<usize>(),
            expected
        );
        assert!(set.rows.iter().all(|r| r.population > 0));
        assert!(set
            .rows
            .iter()
            .any(|r| r.population != set.rows[0].population));
    }
}
