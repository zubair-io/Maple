//! Exact frame evidence and coordinate anchors for native highlight tiles.
use super::{baseline_gain, ceilings, EPSILON};

/// The full frame's tier-3 scene prior, resolved only when a render actually
/// defers a pixel to tier 3, so tiles without large clipped interiors never
/// sample the frame.
pub(crate) trait ScenePrior: Sync {
    fn scene(&self) -> Option<[f32; 3]>;
}

#[derive(Clone, Copy)]
pub(crate) struct FrameAnchor<'a> {
    pub prior: &'a dyn ScenePrior,
    pub origin: (i32, i32),
    pub active_origin: (i32, i32),
}

/// The canonical row-major scene sample selection. Windows supply original
/// post-WB camera pixels in stride-8 raster order; every eligible sample is
/// kept and the shared decimation picks the same subset as the full render.
pub(crate) struct SceneSamples {
    samples: Vec<[f32; 3]>,
    thresholds: [f32; 3],
}
impl SceneSamples {
    pub(crate) fn new(neutral: [f32; 3], baseline_exposure: f32) -> Self {
        let margin = EPSILON * baseline_gain(baseline_exposure);
        Self {
            samples: Vec::new(),
            thresholds: ceilings(neutral, baseline_exposure).map(|v| v - margin),
        }
    }
    pub(crate) fn push(&mut self, p: [f32; 3]) {
        let unclipped = !(p[0] >= self.thresholds[0]
            || p[1] >= self.thresholds[1]
            || p[2] >= self.thresholds[2]);
        if unclipped && p.iter().all(|v| v.is_finite() && *v >= 0.0) {
            self.samples.push(p);
        }
    }
    pub(crate) fn finish(self) -> Option<[f32; 3]> {
        let count = self.samples.len();
        super::guided::decimated_median(self.samples.into_iter(), count)
    }
}
