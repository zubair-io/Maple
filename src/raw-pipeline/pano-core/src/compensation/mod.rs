//! Photometric compensation between panorama frames.
//!
//! Geometric alignment (warping) gets each pixel into the right position;
//! photometric compensation makes them BRIGHTNESS-match so seams aren't
//! visible.
//!
//! Two solver families:
//! - `gain`: whole-image scalar (luma) and whole-image per-channel
//!   (R, G, B). Brown & Lowe 2007. Preserves white balance under
//!   `luma`; can compensate WB drift under `per-channel`.
//! - `block`: per-tile per-channel log-gain field with hard ±log(1.5)
//!   clamp, robust per-tile median, aggressive pixel rejection
//!   (clipped highlights, dark, validity-edge, near-seam, high-
//!   gradient). Default for the panorama pipeline.

pub mod block;
pub mod gain;

pub use block::{
    apply_block_gains, solve_block_gains, BlockGainField, BlockGainOptions,
};
