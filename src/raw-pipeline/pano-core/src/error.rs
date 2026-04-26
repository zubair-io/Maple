//! Error type for the panorama pipeline.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PanoError {
    #[error("decode failed: {0}")]
    Decode(String),

    #[error("not enough matched features: found {found}, needed {needed}")]
    InsufficientMatches { found: usize, needed: usize },

    #[error("bundle adjustment failed to converge: {0}")]
    BundleAdjustment(String),

    #[error("warp failed: {0}")]
    Warp(String),

    #[error("seam finder failed: {0}")]
    Seam(String),

    #[error("blend failed: {0}")]
    Blend(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}
