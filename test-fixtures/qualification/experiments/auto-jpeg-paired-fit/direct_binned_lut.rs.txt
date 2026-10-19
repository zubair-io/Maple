//! Direct paired-pixel Auto candidate, qualified separately under #5000.
use super::{
    lut::{self, ColorLut},
    pairs::DisplayPair,
};

pub(super) fn fit(pairs: &[DisplayPair], size: usize) -> Option<ColorLut> {
    if pairs.len() < 256
        || size < 2
        || pairs
            .iter()
            .any(|p| p.maple.iter().chain(&p.jpeg).any(|v| !v.is_finite()))
    {
        return None;
    }
    let training: Vec<_> = pairs
        .iter()
        .enumerate()
        .filter_map(|(i, p)| (i % 4 != 0).then_some(*p))
        .collect();
    Some(lut::fit_lut_from_pairs(&training, size, 1.))
}

pub(super) fn prefer(candidate: &ColorLut, current: &ColorLut, pairs: &[DisplayPair]) -> bool {
    let mut candidate_error = [0.; 3];
    let mut current_error = [0.; 3];
    for pair in pairs.iter().step_by(4) {
        let a = candidate.sample(pair.maple);
        let b = current.sample(pair.maple);
        for c in 0..3 {
            candidate_error[c] += f64::from(a[c] - pair.jpeg[c]).powi(2);
            current_error[c] += f64::from(b[c] - pair.jpeg[c]).powi(2);
        }
    }
    (0..3).all(|c| candidate_error[c] <= current_error[c])
        && (0..3).any(|c| candidate_error[c] < current_error[c])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pairs(correction: f32) -> Vec<DisplayPair> {
        let mut result = Vec::new();
        for b in 0..5 {
            for g in 0..5 {
                for r in 0..5 {
                    let maple = [r as f32 / 4., g as f32 / 4., b as f32 / 4.];
                    let jpeg = maple.map(|x| x * (1. - correction) + 0.5 * correction);
                    for _ in 0..32 {
                        result.push(DisplayPair { maple, jpeg });
                    }
                }
            }
        }
        result
    }
    #[test]
    fn identity_correspondences_preserve_identity() {
        let lut = fit(&pairs(0.), 5).unwrap();
        for i in 0..100 {
            let x = i as f32 / 99.;
            assert!((lut.sample([x; 3])[0] - x).abs() < 0.00001);
        }
    }
    #[test]
    fn learns_color_pairs_and_improves_held_out_error() {
        let data = pairs(0.2);
        let lut = fit(&data, 5).unwrap();
        assert!(prefer(&lut, &ColorLut::identity(5), &data));
        assert!(lut
            .data
            .iter()
            .all(|v| v.is_finite() && *v >= 0. && *v <= 1.));
        assert!(!prefer(&ColorLut::identity(5), &lut, &data));
    }
    #[test]
    fn rejects_invalid_or_undersized_correspondences() {
        assert!(fit(&pairs(0.)[..100], 5).is_none());
        let mut p = pairs(0.);
        p[2].maple[1] = f32::NAN;
        assert!(fit(&p, 5).is_none());
    }
}
