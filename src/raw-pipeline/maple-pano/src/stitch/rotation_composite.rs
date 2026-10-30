//! Rotation-strategy stage 5 tail: residual exposure field and the tiled
//! composite, every pass reading the surviving frames from the store.

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::composite::{composite_tiled, CanvasSink, CompositeReport};
use crate::frame_store::FrameRows;
use crate::gain::{solve_exposure_field_streaming, FramePhotometry};
use crate::local_align::LocalCorrection;
use crate::seam::SeamConstraint;

use super::{seam_gate, StitchError, StitchOptions};

/// Strip height when `canvas_tile_rows` is unset, so the tiled path (one
/// strip's source rows resident per frame, #1254/#5554) always engages.
const DEFAULT_TILE_ROWS: u32 = 512;

#[allow(clippy::too_many_arguments)]
pub(super) fn composite(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    opts: &StitchOptions,
    seam_constraints: &[SeamConstraint],
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, StitchError> {
    let failed = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    let exposure_field =
        solve_exposure_field_streaming(frames, cameras, photometry, local_corrections, canvas)
            .map_err(failed)?;
    let mut report = composite_tiled(
        frames,
        cameras,
        photometry,
        local_corrections,
        Some(&exposure_field),
        canvas,
        opts.canvas_tile_rows.unwrap_or(DEFAULT_TILE_ROWS),
        opts.seam_strategy,
        seam_constraints,
        sink,
    )
    .map_err(seam_gate::composite_error)?;
    if !opts.capture_owner {
        report.owner = None;
    }
    Ok(report)
}
