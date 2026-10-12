//! Stage 1–2 front end: which detector/matcher pair feeds the match graph.
//!
//! `Ml` is ALIKED + LightGlue on ONNX Runtime; `Classical` (#4523) is the
//! clean-room Harris + gradient-histogram path in
//! [`crate::features::classical`]. Both yield [`FeatureSet`]s and
//! [`PixelCorrespondence`]s through the same glue, so every stage after
//! matching is engine-agnostic. A build carries whichever variants its
//! Cargo features enable; the default is `Ml` when it is compiled in.

#[cfg(feature = "classical-features")]
use crate::features::classical::{
    detect_classical, match_classical, ClassicalMatchOptions, ClassicalOptions,
};
#[cfg(any(feature = "ml", feature = "ml-static"))]
use crate::features::{AlikedDetector, DetectorOptions};
use crate::features::{FeatureSet, LinearRgbFrame};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::ingest::FrameMeta;
#[cfg(any(feature = "ml", feature = "ml-static"))]
use crate::matching::{LightGlueMatcher, MatcherOptions};
#[cfg(any(feature = "ml", feature = "ml-static"))]
use crate::models::ModelDir;
use crate::twoview::PixelCorrespondence;

use super::io::interleave_planar;
use super::types::{StitchError, StitchOptions};

/// Feature detector + matcher used for the proxy match graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeatureEngine {
    /// ALIKED + LightGlue via ONNX Runtime.
    #[cfg(any(feature = "ml", feature = "ml-static"))]
    #[default]
    Ml,
    /// Harris scale-space + gradient-histogram descriptors, no ONNX Runtime.
    #[cfg(feature = "classical-features")]
    #[cfg_attr(not(any(feature = "ml", feature = "ml-static")), default)]
    Classical,
}

/// The stage-2 half of a loaded engine (the detector is released once
/// stage 1 finishes — #3197).
pub(super) enum PairMatcher {
    #[cfg(any(feature = "ml", feature = "ml-static"))]
    Ml(LightGlueMatcher),
    #[cfg(feature = "classical-features")]
    Classical(ClassicalMatchOptions),
}

impl PairMatcher {
    /// Ends the matcher's lifetime so an ONNX session is freed before the
    /// full-resolution stages (#3197).
    pub(super) fn release(self) {}

    pub(super) fn match_pair(
        &mut self,
        a: &FeatureSet,
        b: &FeatureSet,
    ) -> Result<Vec<PixelCorrespondence>, String> {
        match self {
            #[cfg(any(feature = "ml", feature = "ml-static"))]
            Self::Ml(matcher) => matcher
                .match_features(a, b)
                .map(|ml| ml_matches_to_correspondences(&ml, DEFAULT_MIN_SCORE))
                .map_err(|e| e.to_string()),
            #[cfg(feature = "classical-features")]
            Self::Classical(opts) => Ok(ml_matches_to_correspondences(
                &match_classical(a, b, opts),
                DEFAULT_MIN_SCORE,
            )),
        }
    }
}

/// Stage 1: load the selected engine and detect on every proxy. Returns
/// the per-frame feature sets and the matcher for stage 2.
pub(super) fn extract_features(
    metas: &[FrameMeta],
    opts: &StitchOptions,
    progress: &mut impl FnMut(u32, f32),
    is_cancelled: &impl Fn() -> bool,
) -> Result<(Vec<FeatureSet>, PairMatcher), StitchError> {
    match opts.feature_engine {
        #[cfg(any(feature = "ml", feature = "ml-static"))]
        FeatureEngine::Ml => {
            let models = ModelDir::resolve(opts.models_dir.as_deref())
                .map_err(|e| StitchError::MlUnavailable(e.to_string()))?;
            let mut detector = AlikedDetector::load(
                &models,
                DetectorOptions {
                    use_coreml: opts.use_coreml,
                    ..DetectorOptions::default()
                },
            )
            .map_err(|e| StitchError::MlUnavailable(format!("ALIKED load failed: {e}")))?;
            let matcher = LightGlueMatcher::load(
                &models,
                MatcherOptions {
                    use_coreml: opts.use_coreml,
                    ..MatcherOptions::default()
                },
            )
            .map_err(|e| StitchError::MlUnavailable(format!("LightGlue load failed: {e}")))?;
            let sets = detect_each(metas, progress, is_cancelled, |frame| {
                detector.detect(frame).map_err(|e| e.to_string())
            })?;
            Ok((sets, PairMatcher::Ml(matcher)))
        }
        #[cfg(feature = "classical-features")]
        FeatureEngine::Classical => {
            let detector = ClassicalOptions::default();
            let sets = detect_each(metas, progress, is_cancelled, |frame| {
                Ok(detect_classical(frame, &detector))
            })?;
            Ok((
                sets,
                PairMatcher::Classical(ClassicalMatchOptions::default()),
            ))
        }
    }
}

fn detect_each(
    metas: &[FrameMeta],
    progress: &mut impl FnMut(u32, f32),
    is_cancelled: &impl Fn() -> bool,
    mut detect: impl FnMut(&LinearRgbFrame) -> Result<FeatureSet, String>,
) -> Result<Vec<FeatureSet>, StitchError> {
    metas
        .iter()
        .enumerate()
        .map(|(i, meta)| {
            if is_cancelled() {
                return Err(StitchError::Cancelled);
            }
            let feature_error = |cause: String| StitchError::Feature {
                frame_idx: i,
                cause,
            };
            let frame = LinearRgbFrame::new(
                meta.proxy.width(),
                meta.proxy.height(),
                interleave_planar(&meta.proxy),
            )
            .map_err(|e| feature_error(e.to_string()))?;
            let set = detect(&frame).map_err(feature_error)?;
            progress(1, (i + 1) as f32 / metas.len() as f32);
            Ok(set)
        })
        .collect()
}
