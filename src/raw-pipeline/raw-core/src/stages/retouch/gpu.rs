//! Shared geometry/kernel preparation for the staged resident prefix (#4629).

use super::geometry;
use crate::types::retouch::{RetouchKind, RetouchSpot};

/// Prepare once when the frame dimensions or spot list change. Pixel work
/// remains ordered on the GPU; WB ticks borrow these retained values.
pub fn prepare_gpu_spots(spots: &[RetouchSpot], full: (u32, u32)) -> Vec<raw_gpu::GpuRetouchSpot> {
    spots
        .iter()
        .filter_map(|spot| {
            let fp = geometry::footprint(spot, full)?;
            Some(raw_gpu::GpuRetouchSpot {
                center: [fp.center.0, fp.center.1],
                source: [fp.source.0, fp.source.1],
                offset: [fp.off_x.0, fp.off_y.0],
                size: [fp.width() as u32, fp.height() as u32],
                radius: fp.radius_px,
                feather: spot.clamped_feather(),
                opacity: spot.clamped_opacity(),
                heal_kernel: (spot.kind == RetouchKind::Heal)
                    .then(|| crate::stages::blur::gaussian_kernel_1d(fp.sigma)),
            })
        })
        .collect()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "gpu_tests.rs"]
mod tests;
