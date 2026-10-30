//! Exact frame evidence and coordinate anchors for native highlight tiles.
use super::ripple_floors;

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
        Self {
            samples: Vec::new(),
            thresholds: ripple_floors(neutral, baseline_exposure),
        }
    }
    pub(crate) fn push(&mut self, p: [f32; 3]) {
        self.push_with_scale(p, [1.; 3]);
    }
    pub(crate) fn push_with_scale(&mut self, p: [f32; 3], scale: [f32; 3]) {
        let unclipped = !(p[0] >= self.thresholds[0] * scale[0]
            || p[1] >= self.thresholds[1] * scale[1]
            || p[2] >= self.thresholds[2] * scale[2]);
        if unclipped && p.iter().all(|v| v.is_finite() && *v >= 0.0) {
            self.samples.push(p);
        }
    }
    pub(crate) fn finish(self) -> Option<[f32; 3]> {
        let count = self.samples.len();
        super::guided::decimated_median(self.samples.into_iter(), count)
    }
}

/// Banded ingest (#5552): the tier-3 scene samples a full-frame
/// `apply_in_sensor_space` draws from rows `rows` of this band, in its
/// raster order, so concatenating every band's samples and taking
/// [`median_of_band_samples`] reproduces the full render's prior exactly.
/// `img` is a band of post-WB camera RGB whose top row is absolute row
/// `origin_y`; `active_area` is band-local and `region_top_abs` is the
/// absolute top of the frame's sampling region. A band edge that is not the
/// frame edge needs halo rows past `rows` beyond the clip mask's ripple reach.
#[allow(clippy::too_many_arguments)]
pub(crate) fn band_scene_samples(
    img: &crate::image::Image,
    neutral: [f32; 3],
    baseline_exposure: f32,
    active_area: Option<crate::image::CropRect>,
    gains: Option<crate::sensor_gain_maps::ClipGainContext<'_>>,
    rows: (i32, i32),
    origin_y: i32,
    region_top_abs: i32,
) -> Vec<[f32; 3]> {
    let region = active_area.unwrap_or(crate::image::CropRect {
        x: 0,
        y: 0,
        w: img.width,
        h: img.height,
    });
    let left = region.x.min(img.width) as i32;
    let top = region.y.min(img.height) as i32;
    let right = region.x.saturating_add(region.w).min(img.width) as i32;
    let bottom = region.y.saturating_add(region.h).min(img.height) as i32;
    let margin = super::EPSILON * super::baseline_gain(baseline_exposure);
    let thresholds = super::ceilings(neutral, baseline_exposure).map(|ceiling| ceiling - margin);
    let floors = ripple_floors(neutral, baseline_exposure);
    let clip_mask = super::clip_mask_in_sensor_space(
        img,
        thresholds,
        floors,
        (left, top, right, bottom),
        gains,
    );
    let (w, stride) = (img.width as i32, super::guided::SCENE_SAMPLE_STRIDE);
    let clip_mask = &clip_mask;
    (rows.0.max(top)..rows.1.min(bottom))
        .filter(|y| (y + origin_y - region_top_abs).rem_euclid(stride) == 0)
        .flat_map(|y| {
            (left..right).step_by(stride as usize).filter_map(move |x| {
                super::guided::scene_sample(img, clip_mask, floors, gains, (y * w + x) as usize)
            })
        })
        .collect()
}

/// The frame-wide tier-3 median of samples gathered by [`band_scene_samples`].
pub(crate) fn median_of_band_samples(samples: Vec<[f32; 3]>) -> Option<[f32; 3]> {
    let count = samples.len();
    super::guided::decimated_median(samples.into_iter(), count)
}
