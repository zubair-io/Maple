//! Boundary Warp and Auto Crop on the pano C-FFI (#5574): the options the
//! preview and the aligned stitch take, and what they report back.
//! Strengths are percents, the UI slider's own scale.

use maple_pano::boundary_warp::BoundaryWarpStatus;
use maple_pano::stitch::{EdgesReport, StitchOptions};

use crate::error::set_last_error;

/// Edge options for `maple_pano_preview` / `maple_pano_stitch_aligned`.
/// `{0, false}` is the default and leaves the output byte-identical.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MaplePanoEdges {
    /// Boundary Warp strength, a percent in `[0, 100]`.
    pub boundary_warp: f32,
    /// Report the largest rectangle with no empty edges. The image keeps
    /// its whole canvas; the rectangle is the crop to record beside it.
    pub auto_crop: bool,
}

/// What Boundary Warp did. The variants carry a `Warp` prefix because C
/// enum cases share one namespace (`Off` is `MaplePanoLocalAlign`'s).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MaplePanoBoundaryWarpStatus {
    #[default]
    WarpOff = 0,
    WarpApplied = 1,
    /// Applied below the requested strength, which would fold the image.
    WarpClampedFold = 2,
    WarpRefusedFullWrap = 3,
    WarpRefusedDisconnected = 4,
    WarpRefusedEmpty = 5,
    WarpRefusedShape = 6,
    WarpRefusedFold = 7,
    WarpRefusedSolve = 8,
}

/// What the edge options did to the written image.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MaplePanoEdgesReport {
    pub boundary_warp_status: MaplePanoBoundaryWarpStatus,
    /// The strength actually applied, a percent in `[0, 100]`; below the
    /// requested one when clamped, 0 when off or refused.
    pub boundary_warp_applied: f32,
    /// A crop rectangle was found; false when Auto Crop was off or no fully
    /// covered rectangle exists.
    pub auto_cropped: bool,
    /// The written image's size, which the crop rectangle is in.
    pub output_width: u32,
    pub output_height: u32,
    /// The crop rectangle in output pixels; all 0 unless `auto_cropped`.
    pub crop_x: u32,
    pub crop_y: u32,
    pub crop_width: u32,
    pub crop_height: u32,
}

impl From<&EdgesReport> for MaplePanoEdgesReport {
    fn from(edges: &EdgesReport) -> Self {
        let warp = edges.boundary_warp.as_ref();
        let crop = edges.auto_crop.and_then(|c| c.rect);
        Self {
            boundary_warp_status: warp
                .map_or(MaplePanoBoundaryWarpStatus::WarpOff, |w| status(w.status)),
            boundary_warp_applied: warp.map_or(0.0, |w| (w.applied * 100.0) as f32),
            auto_cropped: crop.is_some(),
            output_width: edges.output.0,
            output_height: edges.output.1,
            crop_x: crop.map_or(0, |r| r.x),
            crop_y: crop.map_or(0, |r| r.y),
            crop_width: crop.map_or(0, |r| r.width),
            crop_height: crop.map_or(0, |r| r.height),
        }
    }
}

fn status(s: BoundaryWarpStatus) -> MaplePanoBoundaryWarpStatus {
    use MaplePanoBoundaryWarpStatus as C;
    match s {
        BoundaryWarpStatus::Off => C::WarpOff,
        BoundaryWarpStatus::Applied => C::WarpApplied,
        BoundaryWarpStatus::ClampedFold => C::WarpClampedFold,
        BoundaryWarpStatus::RefusedFullWrap => C::WarpRefusedFullWrap,
        BoundaryWarpStatus::RefusedDisconnected => C::WarpRefusedDisconnected,
        BoundaryWarpStatus::RefusedEmpty => C::WarpRefusedEmpty,
        BoundaryWarpStatus::RefusedShape => C::WarpRefusedShape,
        BoundaryWarpStatus::RefusedFold => C::WarpRefusedFold,
        BoundaryWarpStatus::RefusedSolve => C::WarpRefusedSolve,
    }
}

/// `opts` with `edges` applied; `Err(-10)` with `maple_last_error()` set
/// when the strength is not a finite percent.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub(super) fn with_edges(
    fn_name: &str,
    opts: StitchOptions,
    edges: MaplePanoEdges,
) -> Result<StitchOptions, i32> {
    if !(0.0..=100.0).contains(&edges.boundary_warp) {
        set_last_error(format!(
            "{fn_name}: edges.boundary_warp must be a percent from 0 to 100, got {}",
            edges.boundary_warp
        ));
        return Err(-10);
    }
    Ok(StitchOptions {
        boundary_warp: f64::from(edges.boundary_warp) / 100.0,
        auto_crop: edges.auto_crop,
        ..opts
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strength_outside_a_percent_is_refused() {
        for bad in [-0.5, 100.5, f32::NAN, f32::INFINITY] {
            let edges = MaplePanoEdges {
                boundary_warp: bad,
                auto_crop: false,
            };
            assert_eq!(
                with_edges("t", StitchOptions::default(), edges).err(),
                Some(-10),
                "{bad}"
            );
        }
    }

    #[test]
    fn strength_maps_to_a_fraction() {
        let edges = MaplePanoEdges {
            boundary_warp: 40.0,
            auto_crop: true,
        };
        let opts = with_edges("t", StitchOptions::default(), edges).expect("valid");
        assert!((opts.boundary_warp - 0.4).abs() < 1e-9);
        assert!(opts.auto_crop);
        let off =
            with_edges("t", StitchOptions::default(), MaplePanoEdges::default()).expect("valid");
        assert_eq!((off.boundary_warp, off.auto_crop), (0.0, false));
    }

    #[test]
    fn an_unsolved_warp_reports_off() {
        let report = MaplePanoEdgesReport::from(&EdgesReport {
            boundary_warp: None,
            auto_crop: None,
            uncovered_px: 0,
            output: (1, 1),
        });
        assert_eq!(
            report,
            MaplePanoEdgesReport {
                output_width: 1,
                output_height: 1,
                ..Default::default()
            }
        );
    }

    #[test]
    fn a_found_rectangle_is_reported_in_output_pixels() {
        let rect = maple_pano::composite::CropRect {
            x: 3,
            y: 5,
            width: 40,
            height: 20,
        };
        let report = MaplePanoEdgesReport::from(&EdgesReport {
            boundary_warp: None,
            auto_crop: Some(maple_pano::composite::AutoCropReport {
                rect: Some(rect),
                invalid_px: 0,
            }),
            uncovered_px: 0,
            output: (50, 30),
        });
        assert!(report.auto_cropped);
        assert_eq!((report.output_width, report.output_height), (50, 30));
        assert_eq!(
            (
                report.crop_x,
                report.crop_y,
                report.crop_width,
                report.crop_height
            ),
            (3, 5, 40, 20)
        );
    }
}
