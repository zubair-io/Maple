//! Feature matching — LightGlue via ONNX Runtime (`ml` feature, #1139).
//!
//! Consumes two [`crate::features::FeatureSet`]s (ALIKED keypoints +
//! descriptors) and produces pixel-coordinate correspondences with
//! confidence scores. [`MlMatch`] is the hand-off contract to the #1138
//! geometry side (match-graph construction, MAGSAC++ verification, BA):
//! plain records in source pixel coordinates, no inference types leaking
//! out. The glue that feeds these into the match graph is a small
//! follow-up once both tickets merge — by design, neither side imports
//! the other today.

mod lightglue;

pub use lightglue::{LightGlueMatcher, MatcherOptions};

/// One LightGlue correspondence between two images, in each image's
/// **source continuous pixel coordinates** (texel centers at
/// half-integers — the crate-wide convention, see [`crate::camera`]).
///
/// `score` is LightGlue's match confidence in `[0, 1]` (higher = more
/// confident). Records are emitted in descending score order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MlMatch {
    /// Position in the first image.
    pub x0: f32,
    pub y0: f32,
    /// Position in the second image.
    pub x1: f32,
    pub y1: f32,
    /// LightGlue confidence in `[0, 1]`.
    pub score: f32,
}
