//! Pluggable panorama backends.
//!
//! The crate's default classical pipeline (ORB + arrsac + LM-BA + CPU
//! warp + Dijkstra seam + multi-band blend) is in the `pipeline` module
//! and the per-stage trait implementations. Each `backends/<name>/`
//! submodule wraps an alternative engine — currently AliceVision via
//! subprocess.

pub mod alicevision;
