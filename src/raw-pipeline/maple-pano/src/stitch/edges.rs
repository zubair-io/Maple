//! What Boundary Warp and Auto Crop did to a stitch or preview (#5574).

use crate::boundary_warp::BoundaryWarpReport;
use crate::composite::{AutoCropReport, CompositeReport};
use crate::tile::TileCompositeReport;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgesReport {
    /// `None` at strength 0, when no map was solved.
    pub boundary_warp: Option<BoundaryWarpReport>,
    /// `None` when Auto Crop was off.
    pub auto_crop: Option<AutoCropReport>,
    /// Output pixels no frame covers.
    pub uncovered_px: u64,
    /// The written image's `(width, height)`, the whole canvas.
    pub output: (u32, u32),
}

impl From<&CompositeReport> for EdgesReport {
    fn from(r: &CompositeReport) -> Self {
        Self {
            boundary_warp: r.boundary_warp,
            auto_crop: r.auto_crop,
            uncovered_px: r.uncovered_px,
            output: r.output_size(),
        }
    }
}

impl From<&TileCompositeReport> for EdgesReport {
    fn from(r: &TileCompositeReport) -> Self {
        Self {
            boundary_warp: r.boundary_warp,
            auto_crop: r.auto_crop,
            uncovered_px: r.uncovered_px,
            output: r.output_size(),
        }
    }
}
