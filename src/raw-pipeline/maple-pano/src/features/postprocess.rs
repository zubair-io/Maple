//! ALIKED output selection — pure functions, no ONNX Runtime involved.
//!
//! The pinned export bakes ALIKED's DKD detection head into the graph in
//! **top-k mode**: dense-score NMS (radius 2, SuperPoint-style iterative
//! max-pool suppression), border zeroing, then a global top-2000 pick
//! (`soft_detect.py`). Top-k mode applies **no score threshold** — when an
//! image has fewer than K real maxima, the tail of the output is filled
//! from whatever near-zero scores remain, at essentially arbitrary
//! positions. The selection here is the counterpart that the reference
//! runtime leaves implicit:
//!
//! - **Score threshold** (default `0.2`, ALIKED's `scores_th` default,
//!   strict `>` like the reference mask) — drops the junk tail.
//! - **Radius NMS** (off by default — the graph already suppressed at
//!   radius 2 on the dense map; re-running is only useful with custom
//!   radii, e.g. to thin keypoints for a cheaper match graph).
//! - **Top-k cap** (off by default — the graph already capped at 2000).
//!
//! [`select_keypoints`] returns **indices** into the detector's parallel
//! arrays (coords / scores / descriptors all share indexing), ordered by
//! descending score (ties broken by index, so selection is fully
//! deterministic).

/// Keypoint selection parameters. The defaults reproduce the reference
/// pipeline's effective behavior on the pinned top-k exports; see the
/// module docs for what each knob adds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeypointFilter {
    /// Keep only keypoints with `score > threshold` (strict, matching
    /// ALIKED's `nms_scores > scores_th` mask). `None` keeps everything.
    pub score_threshold: Option<f32>,
    /// Greedy radius NMS in the coordinate space of the keypoints passed
    /// to [`select_keypoints`] (source pixels in the detector flow).
    /// `None` skips NMS.
    pub nms_radius: Option<f32>,
    /// Keep at most this many keypoints (highest scores win). `None`
    /// keeps everything.
    pub max_keypoints: Option<usize>,
}

impl Default for KeypointFilter {
    fn default() -> Self {
        Self {
            score_threshold: Some(0.2),
            nms_radius: None,
            max_keypoints: None,
        }
    }
}

/// Select keypoints by score threshold → greedy radius NMS → top-k cap.
///
/// `xy` and `scores` are parallel arrays. Returns the selected indices in
/// **descending score order** (ties by ascending index). Non-finite
/// scores (NaN tails from a defective run) never pass selection.
///
/// Greedy NMS is O(kept²) in the worst case; at the export's K = 2000
/// that is at most 4·10⁶ distance checks — microseconds, and the
/// threshold pass has usually shrunk the candidate set well below K.
pub fn select_keypoints(xy: &[[f32; 2]], scores: &[f32], filter: &KeypointFilter) -> Vec<usize> {
    debug_assert_eq!(xy.len(), scores.len());
    let n = xy.len().min(scores.len());

    // Threshold pass (NaN-safe: `>` is false for NaN, and the no-threshold
    // path still insists on finite scores).
    let mut candidates: Vec<usize> = (0..n)
        .filter(|&i| {
            let s = scores[i];
            match filter.score_threshold {
                Some(th) => s > th,
                None => s.is_finite(),
            }
        })
        .collect();

    // Deterministic order: descending score, ties by index.
    candidates.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });

    // Greedy radius suppression on the ordered list.
    let selected = match filter.nms_radius {
        Some(radius) if radius > 0.0 => {
            let r2 = radius * radius;
            let mut kept: Vec<usize> = Vec::with_capacity(candidates.len());
            'cand: for &i in &candidates {
                for &j in &kept {
                    let dx = xy[i][0] - xy[j][0];
                    let dy = xy[i][1] - xy[j][1];
                    if dx * dx + dy * dy <= r2 {
                        continue 'cand;
                    }
                }
                kept.push(i);
            }
            kept
        }
        _ => candidates,
    };

    match filter.max_keypoints {
        Some(cap) if selected.len() > cap => selected[..cap].to_vec(),
        _ => selected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(coords: &[(f32, f32)]) -> Vec<[f32; 2]> {
        coords.iter().map(|&(x, y)| [x, y]).collect()
    }

    #[test]
    fn threshold_is_strict_like_the_reference_mask() {
        let xy = pts(&[(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)]);
        let scores = [0.2, 0.200_1, 0.9];
        let filter = KeypointFilter {
            score_threshold: Some(0.2),
            nms_radius: None,
            max_keypoints: None,
        };
        // Exactly-at-threshold is dropped; order is by descending score.
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![2, 1]);
    }

    #[test]
    fn no_threshold_keeps_all_finite_in_score_order() {
        let xy = pts(&[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]);
        let scores = [0.1, 0.5, 0.3];
        let filter = KeypointFilter {
            score_threshold: None,
            nms_radius: None,
            max_keypoints: None,
        };
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![1, 2, 0]);
    }

    #[test]
    fn nan_scores_never_survive() {
        let xy = pts(&[(0.0, 0.0), (1.0, 0.0)]);
        let scores = [f32::NAN, 0.5];
        for th in [None, Some(0.0)] {
            let filter = KeypointFilter {
                score_threshold: th,
                nms_radius: None,
                max_keypoints: None,
            };
            assert_eq!(
                select_keypoints(&xy, &scores, &filter),
                vec![1],
                "th={th:?}"
            );
        }
    }

    #[test]
    fn nms_suppresses_lower_scores_inside_radius() {
        // Cluster of three within r=3 of the winner + one isolated point.
        let xy = pts(&[(0.0, 0.0), (2.0, 0.0), (0.0, 2.5), (50.0, 50.0)]);
        let scores = [0.9, 0.8, 0.7, 0.6];
        let filter = KeypointFilter {
            score_threshold: None,
            nms_radius: Some(3.0),
            max_keypoints: None,
        };
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![0, 3]);
    }

    #[test]
    fn nms_radius_boundary_is_inclusive_suppression() {
        // Distance exactly r → suppressed (`<= r²`), distance just past → kept.
        let xy = pts(&[(0.0, 0.0), (3.0, 0.0), (-3.001, 0.0)]);
        let scores = [0.9, 0.8, 0.7];
        let filter = KeypointFilter {
            score_threshold: None,
            nms_radius: Some(3.0),
            max_keypoints: None,
        };
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![0, 2]);
    }

    #[test]
    fn nms_chains_do_not_revive_suppressed_points() {
        // B is inside A's radius (suppressed). C is inside B's radius but
        // outside A's — greedy NMS keeps C because B never entered the
        // kept set. This pins the greedy (not transitive-cluster) policy.
        let xy = pts(&[(0.0, 0.0), (2.0, 0.0), (4.0, 0.0)]);
        let scores = [0.9, 0.8, 0.7];
        let filter = KeypointFilter {
            score_threshold: None,
            nms_radius: Some(3.0),
            max_keypoints: None,
        };
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![0, 2]);
    }

    #[test]
    fn top_k_cap_applies_after_threshold_and_nms() {
        let xy = pts(&[(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (30.0, 0.0)]);
        let scores = [0.4, 0.9, 0.1, 0.7];
        let filter = KeypointFilter {
            score_threshold: Some(0.2),
            nms_radius: Some(1.0),
            max_keypoints: Some(2),
        };
        // Threshold drops idx 2; order 1,3,0; cap keeps the top two.
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![1, 3]);
    }

    #[test]
    fn equal_scores_break_ties_by_index_for_determinism() {
        let xy = pts(&[(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)]);
        let scores = [0.5, 0.5, 0.5];
        let filter = KeypointFilter {
            score_threshold: None,
            nms_radius: None,
            max_keypoints: None,
        };
        assert_eq!(select_keypoints(&xy, &scores, &filter), vec![0, 1, 2]);
    }

    #[test]
    fn default_filter_matches_aliked_reference_defaults() {
        let d = KeypointFilter::default();
        assert_eq!(d.score_threshold, Some(0.2));
        assert_eq!(d.nms_radius, None);
        assert_eq!(d.max_keypoints, None);
    }

    #[test]
    fn empty_input_yields_empty_selection() {
        let filter = KeypointFilter::default();
        assert!(select_keypoints(&[], &[], &filter).is_empty());
    }
}
