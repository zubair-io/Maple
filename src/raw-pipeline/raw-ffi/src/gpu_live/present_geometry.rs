//! The present shader's manual-geometry homography from the live params,
//! split out of `params.rs` (file budget).

use super::MapleGpuLiveParams;
use raw_core::stages::perspective::{self, Perspective};

/// The manual-geometry homography for the present shader (#3410), built from
/// the C params against the presented image's own `width`/`height`.
///
/// `perspective_scale == 0.0` is read as a stale host and substituted with the
/// canonical 100, so a caller built against a pre-#3410 header — whose zeroed
/// tail would otherwise describe a degenerate zero-scale matrix — resolves to
/// exactly [`Perspective::IDENTITY`] and the shader takes its un-warped path.
/// See the field block on [`MapleGpuLiveParams`] for why this one field cannot
/// use `0.0` as its own identity.
pub(super) fn present_geometry_from_params(
    p: &MapleGpuLiveParams,
    width: u32,
    height: u32,
) -> raw_gpu::PresentGeometry {
    let geometry = Perspective {
        vertical: p.perspective_vertical,
        horizontal: p.perspective_horizontal,
        rotate: p.perspective_rotate,
        scale: if p.perspective_scale == 0.0 {
            Perspective::IDENTITY.scale
        } else {
            p.perspective_scale
        },
        aspect: p.perspective_aspect,
        x: p.perspective_x,
        y: p.perspective_y,
    };
    if geometry.is_identity() {
        return raw_gpu::PresentGeometry::IDENTITY;
    }
    let inverse = geometry.inverse_matrix(perspective::aspect_ratio(width, height));
    raw_gpu::PresentGeometry::from_inverse(inverse.0)
}
