//! Rotation-path photometry: the memory-bounded streaming gain solve with
//! the blind per-lens vignette fallback (#1254, #4522).
//!
//! Each surviving frame is decoded once, its overlap samples accumulated,
//! and its pixels dropped before the next decode — at most one
//! full-resolution frame is resident (cloning every frame was the ~18 GB
//! driver on pano_01).

use std::path::PathBuf;

use crate::camera::Camera;
use crate::gain::{
    solve_photometry_streaming, FramePhotometry, GainOptions, LensFalloff, LensGroups,
};

use super::StitchError;

/// Photometry of the kept frames, and the falloff per lens group with its
/// frames mapped back to input indices. `lenses` covers every input frame;
/// `kept_inputs[k]` is the input index of kept frame `k`.
pub(super) fn solve_kept_photometry(
    kept_paths: &[PathBuf],
    kept_cams: &[Camera],
    lenses: &LensGroups,
    kept_inputs: &[usize],
) -> Result<(Vec<FramePhotometry>, Vec<LensFalloff>), StitchError> {
    let solved = solve_photometry_streaming(
        kept_paths,
        kept_cams,
        &lenses.for_frames(kept_inputs),
        &GainOptions::default(),
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;
    let falloff = solved
        .falloff
        .into_iter()
        .map(|g| LensFalloff {
            frames: g.frames.iter().map(|&k| kept_inputs[k]).collect(),
            ..g
        })
        .collect();
    Ok((solved.frames, falloff))
}
