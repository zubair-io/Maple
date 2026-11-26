//! Memory-bounded tiled composite functions (M6-D, #1248).
//!
//! [`composite_tiled`] composites the canvas strip by strip, reading for each
//! frame only the source rows that strip's warp taps (#5554), so no
//! full-resolution frame is resident. [`composite_tiled_frames`] runs it
//! over frames already in memory.
//!
//! Both dispatch on [`SeamStrategy`] (#1179) and both multi-band blend
//! (#4524) through [`strips`]: Voronoi weights each frame by hard ownership
//! computed from camera geometry alone; `GraphCut` ([`graph_cut`]) samples a
//! downsampled seam solved once before the strip loop. Either way the result
//! equals the whole-canvas [`crate::blend::blend_multiband`] at the band count
//! [`crate::composite::composite`] would pick, independent of `tile_rows`.

mod graph_cut;
mod strips;

use std::ops::Range;

use crate::blend::levels_for_overlap_width;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::frame_store::{FrameRows, InMemory};
use crate::gain::{ExposureField, FramePhotometry};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::seam::{SeamConstraint, SeamConstraintError, SeamStrategy};
use crate::warp::warp_rect_to_canvas;

use super::{AutoCropReport, CanvasCollector, CanvasSink, CompositeReport, UncoveredCount};

/// Memory-bounded tiled compositing: for each strip, read just the source
/// rows each frame's warp taps from `frames`, warp them into the strip's
/// blend window, and fold them into that window's multi-band accumulator.
/// The gain solution is pre-computed by the caller.
///
/// Dispatches on `seam_strategy` (#1179): [`SeamStrategy::Voronoi`]
/// (default) weights by per-pixel ownership from camera geometry alone (no
/// pixels needed); [`SeamStrategy::GraphCut`] delegates to
/// [`graph_cut::composite_tiled_graph_cut`]. The band count follows the
/// same `log2(min overlap width)` rule as [`crate::composite::composite`]
/// and is reported in [`CompositeReport::blend_levels`].
///
/// # Errors
/// Returns `PanoError` if any frame read fails or if camera/frame counts
/// are inconsistent.
#[allow(clippy::too_many_arguments)]
pub fn composite_tiled(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    exposure_field: Option<&ExposureField>,
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
    seam_constraints: &[SeamConstraint],
    auto_crop: bool,
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, PanoError> {
    let mut counted = UncoveredCount::new(sink);
    let sink = &mut counted;
    let report = match seam_strategy {
        SeamStrategy::Voronoi if !seam_constraints.is_empty() => {
            Err(SeamConstraintError::RequiresGraphCut.into())
        }
        SeamStrategy::Voronoi => composite_tiled_voronoi(
            frames,
            cameras,
            photometry,
            local_corrections,
            exposure_field,
            canvas,
            tile_rows,
            auto_crop,
            sink,
        ),
        SeamStrategy::GraphCut => graph_cut::composite_tiled_graph_cut(
            frames,
            cameras,
            photometry,
            local_corrections,
            exposure_field,
            canvas,
            tile_rows,
            seam_constraints,
            auto_crop,
            sink,
        ),
    }?;
    Ok(CompositeReport {
        exposure_field: exposure_field.map(|field| field.summary),
        uncovered_px: counted.uncovered,
        ..report
    })
}

#[allow(clippy::too_many_arguments)]
fn composite_tiled_voronoi(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    exposure_field: Option<&ExposureField>,
    canvas: &CanvasSpec,
    tile_rows: u32,
    auto_crop: bool,
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, PanoError> {
    check_inputs(
        "composite_tiled",
        "frames",
        frames.frame_count(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;
    voronoi_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        auto_crop,
        |fi, rows, cols| {
            warp_frame_rect(
                frames,
                fi,
                cameras,
                photometry,
                local_corrections,
                exposure_field,
                canvas,
                (rows, cols),
            )
        },
        sink,
    )
}

/// Frame `fi` warped into the canvas rectangle `cols` × `rows`, reading
/// only the source rectangle the warp taps, with its exposure correction
/// applied; `None` when the frame puts no sample there.
#[allow(clippy::too_many_arguments)]
fn warp_frame_rect(
    frames: &dyn FrameRows,
    fi: usize,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    exposure_field: Option<&ExposureField>,
    canvas: &CanvasSpec,
    (rows, cols): (Range<u32>, Range<u32>),
) -> Result<Option<PlanarImage>, PanoError> {
    let la = local_corrections.get(fi).and_then(|o| o.as_ref());
    let origin = (cols.start, rows.start);
    let window = warp_rect_to_canvas(
        &cameras[fi],
        canvas,
        photometry[fi],
        la,
        rows,
        cols,
        |rect| frames.read_rect(fi, rect),
    )?;
    Ok(window.map(|w| with_exposure_field(exposure_field, fi, w, canvas, origin)))
}

/// [`composite_tiled`] over frames already in memory, collected into one
/// image (tests, and the preview's proxies).
#[allow(clippy::too_many_arguments)]
pub fn composite_tiled_frames(
    frames: &[PlanarImage],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    exposure_field: Option<&ExposureField>,
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
    seam_constraints: &[SeamConstraint],
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    let mut collector = CanvasCollector::default();
    let report = composite_tiled(
        &InMemory(frames),
        cameras,
        photometry,
        local_corrections,
        exposure_field,
        canvas,
        tile_rows,
        seam_strategy,
        seam_constraints,
        false,
        &mut collector,
    )?;
    Ok((collector.into_image(), report))
}

/// Voronoi weighting: each covered canvas pixel belongs wholly to the frame
/// whose projection of it sits deepest inside that frame.
#[allow(clippy::too_many_arguments)]
fn voronoi_blend(
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    auto_crop: bool,
    warp: impl FnMut(usize, Range<u32>, Range<u32>) -> Result<Option<PlanarImage>, PanoError>,
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, PanoError> {
    let any_owner = |_: usize, _: usize, _: usize| 1.0_f32;
    let crop_weight = auto_crop.then_some(&any_owner as &strips::CropWeight);
    let mut survey = strips::survey(cameras, local_corrections, canvas, true, crop_weight, sink)?;
    let owner = survey.owner.as_ref().expect("survey kept the owner map");
    let levels = levels_for_overlap_width(survey.min_overlap_px);
    strips::blend_strips(
        (canvas.width, canvas.height),
        cameras.len(),
        (tile_rows, strips::TILE_COLS),
        levels,
        |fi, rows, cols| owner.owns_any_in(fi as u16, rows, cols),
        |fi, x, y| {
            if owner.at(x, y) == fi as u16 {
                1.0
            } else {
                0.0
            }
        },
        warp,
        sink,
    )?;
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        photometry: photometry.to_vec(),
        falloff: Vec::new(),
        blend_levels: levels,
        min_overlap_width_px: survey.min_overlap_px,
        seam_strategy: SeamStrategy::Voronoi,
        exposure_field: None,
        owner: survey.owner.take(),
        boundary_warp: None,
        uncovered_px: 0,
        auto_crop: auto_crop.then_some(AutoCropReport {
            rect: survey.crop_rect,
            invalid_px: 0,
        }),
    };
    Ok(report)
}

/// Scale a freshly warped window (pixel `(0, 0)` at canvas `origin`) by
/// frame `fi`'s exposure correction, in place, when a field was solved
/// (#4521).
fn with_exposure_field(
    field: Option<&ExposureField>,
    fi: usize,
    mut strip: PlanarImage,
    canvas: &CanvasSpec,
    origin: (u32, u32),
) -> PlanarImage {
    if let Some(field) = field {
        field.apply_to_strip(fi, &mut strip, canvas, origin);
    }
    strip
}

/// Shared shape validation for every tiled entry point.
fn check_inputs(
    entry: &str,
    noun: &str,
    sources: usize,
    cameras: usize,
    photometry: usize,
    local_corrections: usize,
) -> Result<(), PanoError> {
    if sources != cameras || sources != photometry {
        return Err(PanoError::InvalidOptions(format!(
            "{entry}: {sources} {noun}, {cameras} cameras, {photometry} photometry"
        )));
    }
    if local_corrections != 0 && local_corrections != sources {
        return Err(PanoError::InvalidOptions(format!(
            "{entry}: {local_corrections} local corrections vs {sources} {noun} (pass an empty slice to skip alignment)"
        )));
    }
    if sources == 0 {
        return Err(PanoError::InvalidOptions(format!("{entry}: no frames")));
    }
    Ok(())
}
