//! Brute-force Hamming matcher with Lowe ratio test.
//!
//! For each descriptor in image A we scan all descriptors in image B,
//! retain the best and second-best matches by Hamming distance, and apply
//! Lowe's ratio test (default ratio = 0.75).  An optional mutual nearest
//! neighbour (MNN) filter can be enabled to further reduce false positives.

use crate::error::PanoError;
use crate::traits::FeatureMatcher;
use crate::types::{Features, Match, Matches};

/// Brute-force descriptor matcher for packed binary descriptors (BRIEF/ORB).
///
/// ```
/// use pano_core::matching::BruteForceMatcher;
/// use pano_core::{FeatureMatcher, Features, Matches};
/// let matcher = BruteForceMatcher::default();
/// let a = Features::default();
/// let b = Features::default();
/// let _m = matcher.match_pairs(&a, &b).unwrap();
/// ```
pub struct BruteForceMatcher {
    /// Lowe's ratio test threshold (0.0–1.0).  Lower values are stricter.
    pub ratio: f32,
    /// Enable mutual nearest-neighbour filter for extra precision.
    pub mutual_nn: bool,
}

impl Default for BruteForceMatcher {
    fn default() -> Self {
        Self {
            ratio: 0.75,
            mutual_nn: false,
        }
    }
}

impl BruteForceMatcher {
    pub fn new(ratio: f32, mutual_nn: bool) -> Self {
        Self { ratio, mutual_nn }
    }

    /// Compute the Hamming distance between two packed byte slices.
    #[inline]
    fn hamming(a: &[u8], b: &[u8]) -> u32 {
        debug_assert_eq!(a.len(), b.len());
        a.iter()
            .zip(b.iter())
            .map(|(&x, &y)| (x ^ y).count_ones())
            .sum()
    }

    /// Return a slice of the descriptor for keypoint `idx` from `feats`.
    #[inline]
    fn descriptor(feats: &Features, idx: usize) -> &[u8] {
        let d = feats.descriptor_dim;
        &feats.descriptors[idx * d..(idx + 1) * d]
    }

    /// For every descriptor in `query`, find the (best, second_best) match in
    /// `train` by Hamming distance and apply the ratio test.  Returns a Vec
    /// of `(query_idx, train_idx, distance)` for every passing match.
    fn ratio_matches(&self, query: &Features, train: &Features) -> Vec<(u32, u32, u32)> {
        if query.descriptors.is_empty() || train.descriptors.is_empty() {
            return Vec::new();
        }
        let n_train = train.keypoints.len();
        let mut results = Vec::with_capacity(query.keypoints.len());

        for qi in 0..query.keypoints.len() {
            let qd = Self::descriptor(query, qi);
            let mut best_dist = u32::MAX;
            let mut second_dist = u32::MAX;
            let mut best_ti = 0usize;

            for ti in 0..n_train {
                let td = Self::descriptor(train, ti);
                let d = Self::hamming(qd, td);
                if d < best_dist {
                    second_dist = best_dist;
                    best_dist = d;
                    best_ti = ti;
                } else if d < second_dist {
                    second_dist = d;
                }
            }

            // Ratio test: best < ratio * second_best.
            // Comparison is done in f32 to avoid integer truncation artefacts
            // (e.g. floor(0.75 * 1) = 0 which would reject a 0-vs-1 pair).
            if (best_dist as f32) < self.ratio * (second_dist as f32) {
                results.push((qi as u32, best_ti as u32, best_dist));
            }
        }

        results
    }
}

impl FeatureMatcher for BruteForceMatcher {
    fn match_pairs(&self, a: &Features, b: &Features) -> Result<Matches, PanoError> {
        if a.descriptor_dim != b.descriptor_dim
            && !a.descriptors.is_empty()
            && !b.descriptors.is_empty()
        {
            return Err(PanoError::Other(format!(
                "descriptor dimension mismatch: {} vs {}",
                a.descriptor_dim, b.descriptor_dim
            )));
        }

        if a.descriptors.is_empty() || b.descriptors.is_empty() {
            return Ok(Matches {
                inliers: Vec::new(),
            });
        }

        // Forward pass: for each a-descriptor find best match in b.
        let forward = self.ratio_matches(a, b);

        let inliers = if self.mutual_nn {
            // Reverse pass: for each b-descriptor find best match in a.
            let reverse = self.ratio_matches(b, a);
            // Build a lookup: b_idx → a_idx from the reverse pass.
            let mut rev_map = std::collections::HashMap::<u32, u32>::with_capacity(reverse.len());
            for (bi, ai, _) in &reverse {
                rev_map.insert(*bi, *ai);
            }
            // Keep only mutually agreed pairs.
            forward
                .into_iter()
                .filter(|(ai, bi, _)| rev_map.get(bi).copied() == Some(*ai))
                .map(|(ai, bi, dist)| Match {
                    a: ai,
                    b: bi,
                    distance: dist as f32,
                })
                .collect()
        } else {
            forward
                .into_iter()
                .map(|(ai, bi, dist)| Match {
                    a: ai,
                    b: bi,
                    distance: dist as f32,
                })
                .collect()
        };

        Ok(Matches { inliers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Features;

    #[test]
    fn distinct_descriptors_self_match() {
        // Build 4 descriptors where each is distinct:
        // desc[0] = all zeros
        // desc[1] = first byte 0x01  (1 bit different from 0)
        // desc[2] = first byte 0x03  (2 bits different from 0)
        // desc[3] = first byte 0x0F  (4 bits different from 0)
        //
        // When matching against themselves, descriptor 0 has:
        //   best match: itself (distance=0)
        //   second best: descriptor 1 (distance=1)
        // Ratio test: 0 < 0.75 * 1 = 0.75 → passes.
        let n = 4;
        let descriptor_dim = 32;
        let mut descs = vec![0u8; n * descriptor_dim];
        descs[descriptor_dim] = 0x01;
        descs[descriptor_dim * 2] = 0x03;
        descs[descriptor_dim * 3] = 0x0F;
        let distinct = Features {
            keypoints: (0..n)
                .map(|i| crate::types::Keypoint {
                    x: i as f32,
                    y: 0.0,
                    scale: 1.0,
                    angle: 0.0,
                    response: 1.0,
                })
                .collect(),
            descriptors: descs,
            descriptor_dim,
        };

        let matcher = BruteForceMatcher::default();
        let m = matcher.match_pairs(&distinct, &distinct).unwrap();
        // Descriptor 0 should match descriptor 0 (distance 0, second best = 1).
        let has_self_match = m.inliers.iter().any(|m| m.a == 0 && m.b == 0);
        assert!(
            has_self_match,
            "self match for distinct descriptor 0 expected"
        );
    }

    #[test]
    fn empty_features_return_empty_matches() {
        let a = Features::default();
        let b = Features::default();
        let matcher = BruteForceMatcher::default();
        let m = matcher.match_pairs(&a, &b).unwrap();
        assert!(m.inliers.is_empty());
    }

    #[test]
    fn dimension_mismatch_returns_error() {
        let a = Features {
            keypoints: vec![crate::types::Keypoint {
                x: 0.0,
                y: 0.0,
                scale: 1.0,
                angle: 0.0,
                response: 1.0,
            }],
            descriptors: vec![0u8; 32],
            descriptor_dim: 32,
        };
        let b = Features {
            keypoints: vec![crate::types::Keypoint {
                x: 0.0,
                y: 0.0,
                scale: 1.0,
                angle: 0.0,
                response: 1.0,
            }],
            descriptors: vec![0u8; 16],
            descriptor_dim: 16,
        };
        let matcher = BruteForceMatcher::default();
        assert!(matcher.match_pairs(&a, &b).is_err());
    }
}
