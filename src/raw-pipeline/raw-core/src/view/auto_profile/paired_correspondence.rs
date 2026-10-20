use super::super::{fit_registration::Warp, paired_observations::ObservationSet};

fn supported(warp: Warp, inverse: bool) -> bool {
    if !warp.coefficients.iter().all(|v| v.is_finite()) || !warp.radial.is_finite() {
        return false;
    }
    let mut total = 0;
    for gy in 0..8 {
        for gx in 0..8 {
            let mut covered = 0;
            for y in gy * 16..(gy + 1) * 16 {
                for x in gx * 16..(gx + 1) * 16 {
                    let (u, v) = ((x as f64 + 0.5) / 128., (y as f64 + 0.5) / 128.);
                    let [a, b, c, d] = warp.jacobian(u, v);
                    if a * d - b * c <= 0. {
                        return false;
                    }
                    let p = if inverse {
                        let Some(p) = warp.inverse_map(u, v) else {
                            return false;
                        };
                        p
                    } else {
                        warp.map(u, v)
                    };
                    if p.iter().all(|v| (0. ..=1.).contains(v)) {
                        covered += 1;
                    }
                }
            }
            if covered < 192 {
                return false;
            }
            total += covered;
        }
    }
    total as f64 / (128. * 128.) >= 0.95
}

pub(super) fn supported_both_directions(warp: Warp) -> bool {
    supported(warp, false) && supported(warp, true)
}

pub(super) fn retains_population(original: &ObservationSet, matched: &ObservationSet) -> bool {
    let populations = |set: &ObservationSet| {
        let mut regions = [0usize; 64];
        for row in &set.rows {
            regions[row.region] += row.population;
        }
        regions
    };
    let before = populations(original);
    let after = populations(matched);
    let total: usize = before.iter().sum();
    total > 0
        && after.iter().sum::<usize>() as f64 / total as f64 >= 0.95
        && before
            .iter()
            .zip(after)
            .all(|(&original, aligned)| original > 0 && aligned as f64 / original as f64 >= 0.75)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_and_small_lens_scale_retain_support() {
        assert!(supported_both_directions(Warp::IDENTITY));
        assert!(supported_both_directions(Warp {
            radial: 0.,
            coefficients: [1.016, 0., -0.008, 0., 1.016, -0.008],
        }));
    }
    #[test]
    fn missing_scene_or_singular_coordinates_cannot_qualify() {
        for coefficients in [
            [1., 0., 0.12, 0., 1., 0.],
            [0.8, 0., 0.1, 0., 0.8, 0.1],
            [0., 0., 0., 0., 0., 0.],
            [f64::NAN, 0., 0., 0., 1., 0.],
        ] {
            assert!(!supported_both_directions(Warp {
                coefficients,
                radial: 0.
            }));
        }
    }
    #[test]
    fn actual_pixel_populations_must_retain_every_region_and_the_full_frame() {
        use super::super::Observation;
        let set = |populations: [usize; 64]| ObservationSet {
            rows: populations
                .into_iter()
                .enumerate()
                .map(|(region, population)| Observation {
                    weights: vec![],
                    artifact_weights: vec![],
                    source: [0.; 3],
                    target: [0.; 3],
                    baseline: [0.; 3],
                    population,
                    validation: true,
                    in_bias_region: true,
                    region,
                })
                .collect(),
            grid_width: 8,
            grid_height: 8,
        };
        let original = set([100; 64]);
        assert!(retains_population(&original, &set([95; 64])));
        assert!(!retains_population(&original, &set([94; 64])));
        let mut missing_tile = [100; 64];
        missing_tile[63] = 74;
        assert!(!retains_population(&original, &set(missing_tile)));
        missing_tile[63] = 75;
        assert!(retains_population(&original, &set(missing_tile)));
    }
}
