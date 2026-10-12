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
use crate::ingest::FrameMeta;
use crate::local_align::LocalCorrection;

use super::StitchError;

/// Photometry of the kept frames, and the falloff per lens group with its
/// frames mapped back to input indices.
pub(super) fn solve_kept_photometry(
    kept_paths: &[PathBuf],
    kept_cams: &[Camera],
    metas: &[FrameMeta],
    kept_meta: &[(usize, Camera, Option<LocalCorrection>)],
) -> Result<(Vec<FramePhotometry>, Vec<LensFalloff>), StitchError> {
    let lenses = LensGroups::from_metas(kept_meta.iter().map(|(inp_idx, _, _)| &metas[*inp_idx]));
    let solved =
        solve_photometry_streaming(kept_paths, kept_cams, &lenses, &GainOptions::default())
            .map_err(|e| StitchError::Composite(e.to_string()))?;
    let falloff = solved
        .falloff
        .into_iter()
        .map(|g| LensFalloff {
            frames: g.frames.iter().map(|&k| kept_meta[k].0).collect(),
            ..g
        })
        .collect();
    Ok((solved.frames, falloff))
}
