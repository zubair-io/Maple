//! ML → geometry glue (#1154 deliverable 7): the adapter from the
//! LightGlue matcher's [`MlMatch`] records to the geometry side's
//! [`PixelCorrespondence`] input, in **source-image pixel coordinates**.
//!
//! Both sides already speak source pixels — the detector un-letterboxes
//! its keypoints (`features::postprocess`) and the geometry stack
//! consumes continuous pixel coordinates — so the adaptation is a score
//! gate plus an f32 → f64 widening. The robust verifier downstream is
//! the real outlier filter; `min_score` only sheds matches LightGlue
//! itself considers junk, keeping the verifier's inlier-ratio healthy
//! on low-texture pairs.

use crate::matching::MlMatch;
use crate::twoview::PixelCorrespondence;

/// Default LightGlue confidence floor for graph candidates. Matches the
/// smoke-test operating point: low enough to keep marginal-texture
/// matches flowing to the verifier, high enough to drop the tail
/// LightGlue itself flags as unreliable.
pub const DEFAULT_MIN_SCORE: f32 = 0.1;

/// Convert matcher output into verifier input, dropping records below
/// `min_score`. Coordinates pass through unchanged (both sides are
/// source-image pixels); ordering is preserved (determinism).
pub fn ml_matches_to_correspondences(
    matches: &[MlMatch],
    min_score: f32,
) -> Vec<PixelCorrespondence> {
    matches
        .iter()
        .filter(|m| m.score >= min_score)
        .map(|m| PixelCorrespondence {
            a: (f64::from(m.x0), f64::from(m.y0)),
            b: (f64::from(m.x1), f64::from(m.y1)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_gate_and_widening() {
        let matches = vec![
            MlMatch {
                x0: 1.5,
                y0: 2.5,
                x1: 3.25,
                y1: 4.75,
                score: 0.9,
            },
            MlMatch {
                x0: 9.0,
                y0: 9.0,
                x1: 9.0,
                y1: 9.0,
                score: 0.05,
            },
        ];
        let out = ml_matches_to_correspondences(&matches, DEFAULT_MIN_SCORE);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].a, (1.5, 2.5));
        assert_eq!(out[0].b, (3.25, 4.75));
    }
}
