//! Rotation-strategy stage 5 tail: residual exposure field and the tiled
//! composite, every pass decoding one surviving frame at a time.

use std::path::PathBuf;

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::composite::{composite_tiled, CompositeReport};
use crate::gain::{solve_exposure_field_streaming, FramePhotometry};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::seam::SeamConstraint;

use super::{seam_gate, StitchError, StitchOptions};

/// Strip height when `canvas_tile_rows` is unset, so the tiled path (≤1
/// full-resolution frame resident per strip pass, #1254) always engages.
const DEFAULT_TILE_ROWS: u32 = 512;

pub(super) fn composite(
    paths: &[PathBuf],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    opts: &StitchOptions,
    seam_constraints: &[SeamConstraint],
) -> Result<(PlanarImage, CompositeReport), StitchError> {
    let failed = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    let exposure_field =
        solve_exposure_field_streaming(paths, cameras, photometry, local_corrections, canvas)
            .map_err(failed)?;
    let (image, mut report) = composite_tiled(
        paths,
        cameras,
        photometry,
        local_corrections,
        Some(&exposure_field),
        canvas,
        opts.canvas_tile_rows.unwrap_or(DEFAULT_TILE_ROWS),
        opts.seam_strategy,
        seam_constraints,
    )
    .map_err(seam_gate::composite_error)?;
    if !opts.capture_owner {
        report.owner = None;
    }
    Ok((image, report))
}
