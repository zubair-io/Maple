//! CPU/GPU post-DCP recovery parameters.

/// Slack above 1.0 the predicate still treats as "below the sensor clip";
/// absorbs f32 round-trip noise on the Oklab matrix chain. NOT a gamut
/// tolerance: the working space is unbounded scene-linear Rec.2020.
pub const CEILING_EPSILON: f32 = 0.005;
/// 15 halvings resolve the `[0, 1]` chroma scale to about 3e-5, below the f32
/// round-trip noise on the Oklab matrix chain.
pub const BISECTION_ITERS: u32 = 15;
