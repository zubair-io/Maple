//! Boundary Warp on the stitch (#5572): the panorama's footprint from
//! geometry alone, and the output canvas that composites through the map.

use std::sync::Arc;

use crate::boundary_warp::{self, BoundaryWarpOutcome, BoundaryWarpReport, Footprint};
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::local_align::LocalCorrection;

/// The footprint is evaluated on a copy of the canvas at most this many
/// pixels; the solve coarsens it further.
pub(super) const FOOTPRINT_MAX_PX: usize = 1 << 20;

/// The boundary warp at `strength`; `None` at strength 0, when no footprint
/// is built.
pub(super) fn solve(
    strength: f64,
    footprint: impl FnOnce() -> Footprint,
) -> Option<BoundaryWarpOutcome> {
    (strength > 0.0).then(|| boundary_warp::solve(&footprint(), strength))
}

/// `canvas` composited through the boundary warp at `strength`, with the
/// solve's report; `canvas` itself and no report at strength 0.
pub(super) fn warped_canvas(
    canvas: &CanvasSpec,
    strength: f64,
    footprint: impl FnOnce() -> Footprint,
) -> (CanvasSpec, Option<BoundaryWarpReport>) {
    let outcome = solve(strength, footprint);
    let map = outcome.as_ref().and_then(|o| o.map.clone()).map(Arc::new);
    (
        canvas.clone().with_boundary_warp(map),
        outcome.map(|o| o.report),
    )
}

/// Which pixels of `canvas` some rotation frame covers: a pixel is covered
/// when a camera, after its Stage-F correction, sees its centre inside the
/// frame.
pub(super) fn rotation_footprint(
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
) -> Footprint {
    let proxy = canvas.downscaled(FOOTPRINT_MAX_PX);
    let correction = |fi: usize| local_corrections.get(fi).and_then(Option::as_ref);
    Footprint::from_fn(proxy.width, proxy.height, canvas.is_full_wrap(), |x, y| {
        proxy
            .pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
            .is_some_and(|dir| {
                cameras.iter().enumerate().any(|(fi, cam)| {
                    cam.world_dir_to_pixel(dir).is_some_and(|(fx, fy)| {
                        let (fx, fy) =
                            correction(fi).map_or((fx, fy), |la| la.sample_point(fx, fy));
                        (0.0..=cam.width as f64).contains(&fx)
                            && (0.0..=cam.height as f64).contains(&fy)
                    })
                })
            })
    })
}

#[cfg(test)]
#[path = "boundary_tests.rs"]
mod tests;
