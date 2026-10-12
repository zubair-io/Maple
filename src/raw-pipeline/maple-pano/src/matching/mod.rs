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

#[cfg(any(feature = "ml", feature = "ml-static"))]
mod lightglue;

#[cfg(any(feature = "ml", feature = "ml-static"))]
pub use lightglue::{LightGlueMatcher, MatcherOptions};

/// One matcher correspondence (LightGlue, or the `classical-features`
/// ratio-test matcher — #4523) between two images, in each image's
/// **source continuous pixel coordinates** (texel centers at
/// half-integers — the crate-wide convention, see [`crate::camera`]).
///
/// `score` is the matcher's confidence in `[0, 1]` (higher = more
/// confident). Records are emitted in descending score order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MlMatch {
    /// Position in the first image.
    pub x0: f32,
    pub y0: f32,
    /// Position in the second image.
    pub x1: f32,
    pub y1: f32,
    /// Matcher confidence in `[0, 1]`.
    pub score: f32,
}
