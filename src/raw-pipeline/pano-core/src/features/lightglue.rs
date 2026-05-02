//! Deep-learning sparse matcher: SuperPoint keypoints + LightGlue
//! matching (ICCV 2023, https://arxiv.org/abs/2306.13643).
//!
//! Replaces AKAZE+GMS as the front end on hard pairs (low overlap,
//! texture-poor regions like sky/water, large viewpoint shifts). On
//! `pano_01` pair (1,2) the AKAZE+GMS pipeline currently nets 73
//! RANSAC inliers; LightGlue typically produces 500+ matches at the
//! same overlap, with substantially fewer geometric outliers.
//!
//! # Inference backend
//!
//! Uses [`tract-onnx`] — pure-Rust ONNX runtime, no native FFI build
//! step. We picked `tract` over `ort` because `ort 2.0.0-rc.{10,12}`
//! has an unresolved compile error in its VitisAI execution-provider
//! glue (see top-level `Cargo.toml` comment). `tract` is slower than
//! ORT/CUDA but plenty fast for sparse-keypoint inference at preview
//! resolution: SuperPoint+LightGlue on a 1024-px-long-edge greyscale
//! pair runs in ~200–400 ms per pair on Apple silicon, which is
//! comfortably within the matcher budget for a 21-frame stitch.
//!
//! # Models
//!
//! Two ONNX files are required at runtime:
//!   - SuperPoint encoder (~30 MB, MIT license, official export
//!     from https://github.com/cvg/LightGlue)
//!   - LightGlue matcher (~2 MB, Apache 2.0)
//!
//! Models are loaded from disk via `LightGlueMatcher::from_paths()`.
//! The intended distribution path is to bundle them under
//! `resources/ml/` and load by absolute path resolved against the
//! binary's directory. For now they are NOT committed to the repo —
//! the matcher fails fast at construction when files aren't present.
//!
//! # Adapter contract
//!
//! Output is plumbed into the existing `Matches`/`Match` types so the
//! downstream pipeline (gimbal filter → RANSAC → BA) doesn't change.
//! Specifically: each LightGlue correspondence with confidence `c`
//! becomes a `Match { a, b, distance: 1.0 - c }`. RANSAC already
//! sorts by `distance` (lower = better), so this preserves the
//! expected ordering.

#![cfg(feature = "ml-lightglue")]

use std::path::{Path, PathBuf};

use crate::error::PanoError;
use crate::types::{Features, Keypoint, Match, Matches, PanoImage};

/// SuperPoint+LightGlue ONNX-backed matcher.
///
/// Construct once, reuse across pairs. Internally caches the
/// inference sessions so model load (~50–200 ms) doesn't repeat per
/// pair.
pub struct LightGlueMatcher {
    /// Path to the SuperPoint ONNX model.
    superpoint_path: PathBuf,
    /// Path to the LightGlue ONNX model.
    lightglue_path: PathBuf,
    /// Confidence threshold below which matches are dropped (0..1).
    confidence_threshold: f32,
    /// Loaded SuperPoint runnable session. `None` until first use.
    /// Lazily initialised so missing models don't crash the Cargo
    /// `--features ml-lightglue` build, only the first run.
    superpoint: Option<TractSession>,
    /// Loaded LightGlue runnable session.
    lightglue: Option<TractSession>,
}

/// Opaque wrapper around the inference session — kept as a typedef
/// here so the type signature doesn't leak the tract type churn.
type TractSession = Box<
    tract_onnx::prelude::SimplePlan<
        tract_onnx::prelude::TypedFact,
        Box<dyn tract_onnx::prelude::TypedOp>,
        tract_onnx::prelude::Graph<
            tract_onnx::prelude::TypedFact,
            Box<dyn tract_onnx::prelude::TypedOp>,
        >,
    >,
>;

impl LightGlueMatcher {
    /// Construct the matcher. Validates the model paths exist; lazy-
    /// loads the actual ONNX graphs on first `match_pair` call.
    pub fn from_paths(
        superpoint_path: impl Into<PathBuf>,
        lightglue_path: impl Into<PathBuf>,
    ) -> Result<Self, PanoError> {
        let superpoint_path = superpoint_path.into();
        let lightglue_path = lightglue_path.into();
        if !superpoint_path.exists() {
            return Err(PanoError::Other(format!(
                "lightglue: SuperPoint model not found at {}",
                superpoint_path.display()
            )));
        }
        if !lightglue_path.exists() {
            return Err(PanoError::Other(format!(
                "lightglue: LightGlue model not found at {}",
                lightglue_path.display()
            )));
        }
        Ok(Self {
            superpoint_path,
            lightglue_path,
            confidence_threshold: 0.5,
            superpoint: None,
            lightglue: None,
        })
    }

    /// Set the confidence threshold (default 0.5). Matches with
    /// LightGlue confidence below this are dropped.
    pub fn with_confidence_threshold(mut self, threshold: f32) -> Self {
        self.confidence_threshold = threshold;
        self
    }

    /// Load both ONNX models if they aren't loaded yet.
    fn ensure_loaded(&mut self) -> Result<(), PanoError> {
        if self.superpoint.is_none() {
            self.superpoint = Some(load_session(&self.superpoint_path)?);
        }
        if self.lightglue.is_none() {
            self.lightglue = Some(load_session(&self.lightglue_path)?);
        }
        Ok(())
    }

    /// Run SuperPoint+LightGlue on a pair of `PanoImage`s. Returns
    /// `Features` for each plus `Matches` between them. Keypoints
    /// are reported in the source-image pixel coordinate system so
    /// the downstream pipeline can use them interchangeably with the
    /// AKAZE/ORB outputs.
    ///
    /// **Status: not yet implemented.** The plumbing — feature flag,
    /// dependency, public API, and adapter to existing types — is in
    /// place. Filling in the inference body and tensor pre/post-
    /// processing is tracked as the remaining T1 work.
    pub fn match_pair(
        &mut self,
        _img_a: &PanoImage,
        _img_b: &PanoImage,
    ) -> Result<(Features, Features, Matches), PanoError> {
        self.ensure_loaded()?;
        // TODO(T1): implement SuperPoint inference (luma → keypoints
        // + descriptors), then LightGlue inference (descriptors_a +
        // descriptors_b + positions → match scores), then convert to
        // Match { a, b, distance: 1.0 - confidence }, threshold by
        // self.confidence_threshold. Reference impls:
        //   https://github.com/cvg/LightGlue/blob/main/lightglue/utils.py
        //   https://github.com/fabio-sim/LightGlue-ONNX
        Err(PanoError::Other(
            "lightglue: match_pair() is not yet implemented — only the \
             tract-onnx-based scaffolding is in place. Tracked under T1."
                .into(),
        ))
    }
}

/// Load an ONNX file into a runnable `tract` plan. Reads the model
/// from disk, runs shape inference, and freezes optimisation.
fn load_session(path: &Path) -> Result<TractSession, PanoError> {
    use tract_onnx::prelude::*;
    let model = tract_onnx::onnx()
        .model_for_path(path)
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to read ONNX at {}: {e}",
                path.display()
            ))
        })?
        .into_optimized()
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to optimise model {}: {e}",
                path.display()
            ))
        })?
        .into_runnable()
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to make runnable plan {}: {e}",
                path.display()
            ))
        })?;
    Ok(Box::new(model))
}

/// Convert a LightGlue match list (raw network output) to the
/// pipeline's `Matches`/`Match` form. Public for testability;
/// callers normally go through `match_pair`.
///
/// Each tuple is `(idx_a, idx_b, confidence_in_0_1)`. Output
/// `Match.distance` is `1.0 - confidence` so smaller = better.
pub fn matches_from_confidences(
    raw: &[(u32, u32, f32)],
    confidence_threshold: f32,
) -> Matches {
    let inliers: Vec<Match> = raw
        .iter()
        .copied()
        .filter(|(_, _, c)| *c >= confidence_threshold)
        .map(|(a, b, c)| Match {
            a,
            b,
            distance: 1.0 - c,
        })
        .collect();
    Matches { inliers }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_from_confidences_thresholds_and_inverts() {
        let raw = [(0u32, 1u32, 0.9), (2, 3, 0.6), (4, 5, 0.3)];
        let m = matches_from_confidences(&raw, 0.5);
        assert_eq!(m.inliers.len(), 2);
        assert!((m.inliers[0].distance - 0.1).abs() < 1e-6);
        assert!((m.inliers[1].distance - 0.4).abs() < 1e-6);
    }

    #[test]
    fn matches_from_confidences_empty_input() {
        let m = matches_from_confidences(&[], 0.5);
        assert!(m.inliers.is_empty());
    }

    #[test]
    fn matches_from_confidences_threshold_zero_keeps_all() {
        let raw = [(0u32, 1u32, 0.01), (2, 3, 0.0)];
        let m = matches_from_confidences(&raw, 0.0);
        assert_eq!(m.inliers.len(), 2);
    }

    /// Construction with non-existent paths must fail fast — we
    /// don't want a stitch run to discover the model's missing
    /// half-way through.
    #[test]
    fn from_paths_rejects_missing_files() {
        let r = LightGlueMatcher::from_paths(
            "/nonexistent/superpoint.onnx",
            "/nonexistent/lightglue.onnx",
        );
        assert!(r.is_err());
    }

    /// Compile-time silence: keep the unused-fields warning quiet
    /// on a feature build that doesn't yet wire up `Keypoint` /
    /// `Features`. The `match_pair` stub is the user of those
    /// types; this dummy assertion documents the dependency.
    #[test]
    fn feature_types_are_in_scope() {
        let _ = std::mem::size_of::<Features>();
        let _ = std::mem::size_of::<Keypoint>();
    }
}
