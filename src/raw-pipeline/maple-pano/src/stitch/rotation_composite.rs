//! Rotation-strategy stage 5 tail: photometry, residual exposure field and
//! the tiled composite, every pass decoding one surviving frame at a time.

use std::path::PathBuf;

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::composite::{composite_tiled, CompositeReport};
use crate::gain::{solve_exposure_field_streaming, solve_photometry_streaming, GainOptions};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;

use super::{StitchError, StitchOptions};

/// Strip height when `canvas_tile_rows` is unset, so the tiled path (≤1
/// full-resolution frame resident per strip pass, #1254) always engages.
const DEFAULT_TILE_ROWS: u32 = 512;

pub(super) fn composite(
    paths: &[PathBuf],
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    opts: &StitchOptions,
) -> Result<(PlanarImage, CompositeReport), StitchError> {
    let failed = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    // #1254: cloning every surviving full-res frame for the gain solve was
    // the dominant ~18 GB driver on pano_01; the streaming solves decode,
    // sample and drop one frame at a time instead.
    let photometry =
        solve_photometry_streaming(paths, cameras, &GainOptions::default()).map_err(failed)?;
    let exposure_field =
        solve_exposure_field_streaming(paths, cameras, &photometry, local_corrections, canvas)
            .map_err(failed)?;
    composite_tiled(
        paths,
        cameras,
        &photometry,
        local_corrections,
        Some(&exposure_field),
        canvas,
        opts.canvas_tile_rows.unwrap_or(DEFAULT_TILE_ROWS),
        opts.seam_strategy,
    )
    .map_err(failed)
}
