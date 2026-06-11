//! LightGlue matcher session (ONNX Runtime via `ort`).
//!
//! The pinned matcher-head export (`models.toml [lightglue]`) takes the
//! ALIKED detector's outputs directly:
//!
//! - `kpts0` / `kpts1`: `[1, N, 2]` f32 — the detector's `[-1, 1]`
//!   normalized keypoint coordinates, **unchanged**. The reference
//!   runtime (ikeboo `find_matches_from_kpts`) feeds ALIKED's normalized
//!   output straight through, because ALIKED's normalization is exactly
//!   the centered/scaled encoding LightGlue was trained with — this crate
//!   keeps the same contract via `FeatureSet::norm_keypoints`.
//! - `desc0` / `desc1`: `[1, N, D]` f32 descriptor rows.
//!
//! and emits `matches0` (int64 index pairs) + `mscores0` (f32
//! confidences). Output decoding handles both published layout families
//! (sparse pairs `[K, 2]` + `[K]`, and per-query `[N₀]` + `[N₀]` with
//! `-1` for unmatched) as pure, unit-tested functions — model swaps
//! within those families are a `models.toml` re-pin, not a code change.

use std::path::PathBuf;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use crate::features::FeatureSet;
use crate::matching::MlMatch;
use crate::models::{MlError, ModelDir, OrtRuntime};

/// Input names baked into the pinned export.
const IN_KPTS0: &str = "kpts0";
const IN_KPTS1: &str = "kpts1";
const IN_DESC0: &str = "desc0";
const IN_DESC1: &str = "desc1";
/// Output names baked into the pinned export.
const OUT_MATCHES: &str = "matches0";
const OUT_SCORES: &str = "mscores0";

/// Matcher configuration.
#[derive(Debug, Clone)]
pub struct MatcherOptions {
    /// Drop matches with confidence `<= score_threshold`. `0.2` is the
    /// reference runtime's default; lower it for hard low-overlap pairs.
    pub score_threshold: f32,
    /// Intra-op thread count for the session (`None` = ONNX Runtime's
    /// default heuristic).
    pub intra_threads: Option<usize>,
}

impl Default for MatcherOptions {
    fn default() -> Self {
        Self {
            score_threshold: 0.2,
            intra_threads: None,
        }
    }
}

/// LightGlue matcher. Construct once with [`LightGlueMatcher::load`],
/// reuse across pairs.
pub struct LightGlueMatcher {
    session: Session,
    model_path: PathBuf,
    options: MatcherOptions,
}

impl LightGlueMatcher {
    /// Load the verified LightGlue model from `models` (CPU execution
    /// provider — CoreML EP is a later milestone, eng design spec §5).
    pub fn load(models: &ModelDir, options: MatcherOptions) -> Result<Self, MlError> {
        OrtRuntime::preflight(None)?;
        let mut builder = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
            .map_err(|e| MlError::Runtime(format!("session builder: {e}")))?;
        if let Some(threads) = options.intra_threads {
            builder = builder
                .with_intra_threads(threads)
                .map_err(|e| MlError::Runtime(format!("intra threads: {e}")))?;
        }
        let session = builder.commit_from_file(&models.lightglue).map_err(|e| {
            MlError::Runtime(format!("loading {}: {e}", models.lightglue.display()))
        })?;

        // Validate the input interface up front — a wrong model file
        // should fail at load, not at first match.
        for name in [IN_KPTS0, IN_KPTS1, IN_DESC0, IN_DESC1] {
            if !session.inputs.iter().any(|i| i.name == name) {
                let have: Vec<&str> = session.inputs.iter().map(|i| i.name.as_str()).collect();
                return Err(MlError::ModelInterface {
                    path: models.lightglue.clone(),
                    reason: format!("input `{name}` is missing (model inputs: {have:?})"),
                });
            }
        }
        Ok(Self {
            session,
            model_path: models.lightglue.clone(),
            options,
        })
    }

    /// Match two detections. Returns pixel-coordinate correspondences
    /// with confidence `> score_threshold`, descending score order.
    ///
    /// The two `FeatureSet`s may have different keypoint counts (the
    /// export's N axes are dynamic); their descriptor widths must agree.
    pub fn match_features(
        &mut self,
        a: &FeatureSet,
        b: &FeatureSet,
    ) -> Result<Vec<MlMatch>, MlError> {
        if a.is_empty() || b.is_empty() {
            return Ok(Vec::new());
        }
        if a.descriptor_dim != b.descriptor_dim {
            return Err(MlError::BadImage(format!(
                "descriptor width mismatch: {} vs {} (different detector models?)",
                a.descriptor_dim, b.descriptor_dim
            )));
        }
        let (n_a, n_b, d) = (a.len(), b.len(), a.descriptor_dim);

        let mut kpts0 = Vec::with_capacity(n_a * 2);
        for k in &a.norm_keypoints {
            kpts0.extend_from_slice(k);
        }
        let mut kpts1 = Vec::with_capacity(n_b * 2);
        for k in &b.norm_keypoints {
            kpts1.extend_from_slice(k);
        }

        let t_kpts0 = Tensor::from_array(([1_usize, n_a, 2], kpts0))
            .map_err(|e| MlError::Inference(format!("kpts0 tensor: {e}")))?;
        let t_kpts1 = Tensor::from_array(([1_usize, n_b, 2], kpts1))
            .map_err(|e| MlError::Inference(format!("kpts1 tensor: {e}")))?;
        let t_desc0 = Tensor::from_array(([1_usize, n_a, d], a.descriptors.clone()))
            .map_err(|e| MlError::Inference(format!("desc0 tensor: {e}")))?;
        let t_desc1 = Tensor::from_array(([1_usize, n_b, d], b.descriptors.clone()))
            .map_err(|e| MlError::Inference(format!("desc1 tensor: {e}")))?;

        let model_path = self.model_path.clone();
        let ierr = |reason: String| MlError::ModelInterface {
            path: model_path.clone(),
            reason,
        };
        let outputs = self
            .session
            .run(ort::inputs![
                IN_KPTS0 => t_kpts0,
                IN_KPTS1 => t_kpts1,
                IN_DESC0 => t_desc0,
                IN_DESC1 => t_desc1,
            ])
            .map_err(|e| MlError::Inference(format!("LightGlue inference: {e}")))?;

        let matches_value = outputs
            .get(OUT_MATCHES)
            .ok_or_else(|| ierr(format!("output `{OUT_MATCHES}` is missing")))?;
        let (m_shape, m_data) = matches_value
            .try_extract_tensor::<i64>()
            .map_err(|e| ierr(format!("extracting `{OUT_MATCHES}`: {e}")))?;
        let scores_value = outputs
            .get(OUT_SCORES)
            .ok_or_else(|| ierr(format!("output `{OUT_SCORES}` is missing")))?;
        let (s_shape, s_data) = scores_value
            .try_extract_tensor::<f32>()
            .map_err(|e| ierr(format!("extracting `{OUT_SCORES}`: {e}")))?;

        let raw = decode_match_outputs(m_shape, m_data, s_shape, s_data).map_err(&ierr)?;
        let mut matches =
            assemble_matches(&raw, a, b, self.options.score_threshold).map_err(ierr)?;
        // Descending confidence, ties by (idx_a, idx_b) input order —
        // deterministic for identical inputs.
        matches.sort_by(|p, q| {
            q.score
                .partial_cmp(&p.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(matches)
    }
}

/// Decode LightGlue raw outputs into `(idx_a, idx_b, confidence)`.
///
/// Two published layout families (see module docs):
/// 1. **Sparse pairs** — `matches0` `[K, 2]` (or `[1, K, 2]`), `mscores0`
///    `[K]`: rows are explicit `(idx_a, idx_b)` pairs.
/// 2. **Per-query** — `matches0` `[N₀]` (or `[1, N₀]`), `mscores0`
///    `[N₀]`: entry `i` is the matched index in image B or `-1`.
///
/// Pure function — unit-tested without ort.
fn decode_match_outputs(
    m_shape: &[i64],
    m_data: &[i64],
    s_shape: &[i64],
    s_data: &[f32],
) -> Result<Vec<(u32, u32, f32)>, String> {
    // Layout discrimination: a sparse-pairs tensor has rank >= 2 with a
    // trailing axis of 2 *and* one score per index pair. The score-count
    // check resolves the genuinely ambiguous tiny shapes (`[1, 2]` is one
    // sparse pair when there is 1 score, or a 2-query per-query result
    // when there are 2).
    let sparse = m_shape.len() >= 2
        && m_shape.last().copied() == Some(2)
        && s_data.len() * 2 == m_data.len();
    if sparse {
        let k = m_data.len() / 2;
        let mut out = Vec::with_capacity(k);
        for i in 0..k {
            let (ia, ib) = (m_data[i * 2], m_data[i * 2 + 1]);
            if ia < 0 || ib < 0 {
                continue; // defensive: padded/unmatched entries
            }
            out.push((ia as u32, ib as u32, s_data[i]));
        }
        Ok(out)
    } else {
        // Per-query.
        if m_data.len() != s_data.len() {
            return Err(format!(
                "unrecognized LightGlue output layout: matches0 {m_shape:?} \
                 ({} values) vs mscores0 {s_shape:?} ({} values)",
                m_data.len(),
                s_data.len()
            ));
        }
        let mut out = Vec::with_capacity(m_data.len());
        for (i, &ib) in m_data.iter().enumerate() {
            if ib < 0 {
                continue;
            }
            out.push((i as u32, ib as u32, s_data[i]));
        }
        Ok(out)
    }
}

/// Map decoded index pairs to pixel-space [`MlMatch`] records, applying
/// the confidence threshold (strict `>`, like the reference runtime's
/// `mscores0 > score_thresh` mask). Errors on out-of-range indices — a
/// model emitting them is broken and must not silently corrupt geometry.
///
/// Pure function — unit-tested without ort.
fn assemble_matches(
    raw: &[(u32, u32, f32)],
    a: &FeatureSet,
    b: &FeatureSet,
    score_threshold: f32,
) -> Result<Vec<MlMatch>, String> {
    let mut out = Vec::with_capacity(raw.len());
    for &(ia, ib, score) in raw {
        let (ia, ib) = (ia as usize, ib as usize);
        if ia >= a.len() || ib >= b.len() {
            return Err(format!(
                "match index ({ia}, {ib}) out of range for keypoint counts ({}, {})",
                a.len(),
                b.len()
            ));
        }
        // Strict `>` keeps only confidently-greater scores; NaN compares
        // as incomparable and is dropped with them.
        if score.partial_cmp(&score_threshold) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let (ka, kb) = (&a.keypoints[ia], &b.keypoints[ib]);
        out.push(MlMatch {
            x0: ka.x,
            y0: ka.y,
            x1: kb.x,
            y1: kb.y,
            score,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::Keypoint;

    fn feature_set(points: &[(f32, f32)]) -> FeatureSet {
        FeatureSet {
            keypoints: points
                .iter()
                .map(|&(x, y)| Keypoint { x, y, score: 1.0 })
                .collect(),
            descriptors: vec![0.0; points.len() * 2],
            descriptor_dim: 2,
            norm_keypoints: vec![[0.0, 0.0]; points.len()],
        }
    }

    #[test]
    fn decode_sparse_pairs_layout() {
        let m = [0_i64, 3, 2, 1, -1, 5];
        let s = [0.9_f32, 0.8, 0.7];
        let raw = decode_match_outputs(&[3, 2], &m, &[3], &s).expect("decode");
        assert_eq!(raw, vec![(0, 3, 0.9), (2, 1, 0.8)]);
        // [1, K, 2] variant decodes identically.
        let raw = decode_match_outputs(&[1, 3, 2], &m, &[1, 3], &s).expect("decode");
        assert_eq!(raw, vec![(0, 3, 0.9), (2, 1, 0.8)]);
    }

    #[test]
    fn decode_per_query_layout_skips_unmatched() {
        let m = [3_i64, -1, 0];
        let s = [0.9_f32, 0.0, 0.6];
        let raw = decode_match_outputs(&[3], &m, &[3], &s).expect("decode");
        assert_eq!(raw, vec![(0, 3, 0.9), (2, 0, 0.6)]);
    }

    #[test]
    fn decode_rejects_inconsistent_lengths() {
        assert!(decode_match_outputs(&[2, 2], &[0, 1, 2, 3], &[1], &[0.5]).is_err());
        assert!(decode_match_outputs(&[3], &[0, 1, 2], &[2], &[0.5, 0.5]).is_err());
    }

    /// `[1, 2]` is the genuinely ambiguous shape: one sparse pair (one
    /// score) vs. a two-query per-query result (two scores). The score
    /// count must disambiguate.
    #[test]
    fn decode_disambiguates_tiny_shapes_by_score_count() {
        // One sparse pair (0 ↔ 1) with one score.
        let raw = decode_match_outputs(&[1, 2], &[0, 1], &[1], &[0.9]).expect("sparse");
        assert_eq!(raw, vec![(0, 1, 0.9)]);
        // Two queries, both matched, two scores.
        let raw = decode_match_outputs(&[1, 2], &[1, 0], &[1, 2], &[0.9, 0.8]).expect("per-query");
        assert_eq!(raw, vec![(0, 1, 0.9), (1, 0, 0.8)]);
        // Rank-1 [2] is per-query even though it ends in 2.
        let raw = decode_match_outputs(&[2], &[-1, 0], &[2], &[0.0, 0.7]).expect("per-query");
        assert_eq!(raw, vec![(1, 0, 0.7)]);
    }

    #[test]
    fn decode_empty_outputs_yield_no_matches() {
        // An empty [0, 2] result (no matches found) must decode cleanly.
        assert!(decode_match_outputs(&[0, 2], &[], &[0], &[])
            .expect("decode")
            .is_empty());
        assert!(decode_match_outputs(&[0], &[], &[0], &[])
            .expect("decode")
            .is_empty());
    }

    #[test]
    fn assemble_thresholds_strictly_and_maps_pixels() {
        let a = feature_set(&[(10.0, 20.0), (30.0, 40.0)]);
        let b = feature_set(&[(11.0, 21.0), (31.0, 41.0)]);
        let raw = [(0_u32, 0_u32, 0.9_f32), (1, 1, 0.2), (1, 0, f32::NAN)];
        let out = assemble_matches(&raw, &a, &b, 0.2).expect("assemble");
        // 0.2 is dropped (strict >), NaN is dropped.
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0],
            MlMatch {
                x0: 10.0,
                y0: 20.0,
                x1: 11.0,
                y1: 21.0,
                score: 0.9
            }
        );
    }

    #[test]
    fn assemble_rejects_out_of_range_indices() {
        let a = feature_set(&[(0.0, 0.0)]);
        let b = feature_set(&[(1.0, 1.0)]);
        assert!(assemble_matches(&[(0, 1, 0.9)], &a, &b, 0.0).is_err());
        assert!(assemble_matches(&[(7, 0, 0.9)], &a, &b, 0.0).is_err());
    }

    #[test]
    fn matcher_options_default_matches_reference_runtime() {
        assert_eq!(MatcherOptions::default().score_threshold, 0.2);
    }
}
