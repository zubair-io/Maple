//! Removal selection mapping (#3934): oriented, post-perspective, pre-user-crop
//! UV -> pre-optical native DefaultCrop UV. Optional crop_input_size maps actual
//! cropped output first; hosts undo only the viewport. Never clamp the surround.
use super::pano::{
    opcode_apply::{LensCorrectionScales, WarpPointMap},
    opcodes::{ActiveAreaRect, PanoOpcode},
};
use crate::{
    image::{CropRect, ExifOrientation, RawImage},
    lens_profile::{self, model::Calibration},
    stages::perspective::{Homography, Perspective},
    xmp::AdjustmentModel,
};

enum Optics {
    Embedded(Vec<WarpPointMap>),
    External {
        calibration: Calibration,
        area: ActiveAreaRect,
    },
    Identity,
}

/// Metadata-only preparation. No image allocation, decoding or inference.
/// Green is the geometric reference; per-channel CA is applied later to the
/// accepted RGB patch by the renderer, never baked into selection coordinates.
pub struct RemovalGeometry {
    crop: CropRect,
    orientation: ExifOrientation,
    inverse_perspective: Homography,
    optics: Optics,
    scales: LensCorrectionScales,
}

impl RemovalGeometry {
    pub fn new(raw: &RawImage, model: &AdjustmentModel) -> Result<Self, String> {
        Self::for_frame(raw, model, None)
    }

    fn for_frame(
        raw: &RawImage,
        model: &AdjustmentModel,
        frame_size: Option<[u32; 2]>,
    ) -> Result<Self, String> {
        let crop = raw
            .crop_rect
            .and_then(|c| CropRect::clamped(c.x, c.y, c.w, c.h, raw.width, raw.height))
            .unwrap_or(CropRect {
                x: 0,
                y: 0,
                w: raw.width,
                h: raw.height,
            });
        if crop.w == 0 || crop.h == 0 {
            return Err("removal geometry: no native source pixels".into());
        }
        let scales = LensCorrectionScales::from_model(model);
        let optics = if let Some((list, area)) = &raw.opcode_list3 {
            if area.width == 0
                || area.height == 0
                || area
                    .left
                    .checked_add(area.width)
                    .is_none_or(|v| v > raw.width)
                || area
                    .top
                    .checked_add(area.height)
                    .is_none_or(|v| v > raw.height)
            {
                return Err("removal geometry: invalid embedded active area".into());
            }
            let maps = if scales.distortion == 0.0 && scales.ca == 0.0 {
                Vec::new()
            } else {
                list.opcodes
                    .iter()
                    .filter_map(|opcode| match opcode {
                        PanoOpcode::WarpRectilinear(warp) => {
                            Some(WarpPointMap::new(warp, *area, scales.distortion, scales.ca))
                        }
                        _ => None,
                    })
                    .collect::<Result<Vec<_>, _>>()?
            };
            Optics::Embedded(maps)
        } else if lens_profile::applies(raw, model) {
            match lens_profile::resolve_for_model(raw, model)? {
                Some(resolution) => {
                    if lens_profile::needs_acknowledgement(&model.lens_profile, &resolution) {
                        return Err(
                            "removal geometry: LCP approximation requires acknowledgement".into(),
                        );
                    }
                    let area = raw
                        .lens_metadata
                        .active_area
                        .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
                    if area.width == 0
                        || area.height == 0
                        || area
                            .left
                            .checked_add(area.width)
                            .is_none_or(|v| v > raw.width)
                        || area
                            .top
                            .checked_add(area.height)
                            .is_none_or(|v| v > raw.height)
                    {
                        return Err("removal geometry: invalid lens active area".into());
                    }
                    Optics::External {
                        calibration: resolution.calibration,
                        area,
                    }
                }
                None => Optics::Identity,
            }
        } else {
            Optics::Identity
        };
        let aspect = if let Some([w, h]) = frame_size {
            crate::stages::perspective::aspect_ratio(w, h)
        } else if raw.orientation.swaps_wh() {
            crop.h as f32 / crop.w as f32
        } else {
            crop.w as f32 / crop.h as f32
        };
        Ok(Self {
            crop,
            orientation: raw.orientation,
            inverse_perspective: Perspective::from_model(model).inverse_matrix(aspect),
            optics,
            scales,
        })
    }

    pub fn source_size(&self) -> [u32; 2] {
        [self.crop.w, self.crop.h]
    }

    /// Unmapped surround, projective horizons and samples outside the durable
    /// DefaultCrop plate return None. This must not become clamped edge paint.
    /// Input and output UV use pixel-edge coordinates (pixel 0 centre is .5/W).
    pub fn source(&self, point: [f32; 2]) -> Option<[f32; 2]> {
        if point
            .iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return None;
        }
        let (x, y) = self
            .inverse_perspective
            .project(point[0] * 2.0 - 1.0, point[1] * 2.0 - 1.0)?;
        let (u, v) = ((x + 1.0) * 0.5, (y + 1.0) * 0.5);
        if [u, v]
            .iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return None;
        }
        let [u, v] = self.orientation.display_uv_to_sensor([u, v]);
        let point = [
            u as f64 * self.crop.w as f64 + self.crop.x as f64 - 0.5,
            v as f64 * self.crop.h as f64 + self.crop.y as f64 - 0.5,
        ];
        let point = match &self.optics {
            // Render list order is forward; a destination lookup follows the
            // gathers in reverse to reach the original recorded source.
            Optics::Embedded(maps) => maps
                .iter()
                .rev()
                .fold(point, |point, map| map.source(point)),
            Optics::External { calibration, area } => {
                let local = [point[0] - area.left as f64, point[1] - area.top as f64];
                if local[0] < 0.0
                    || local[1] < 0.0
                    || local[0] >= area.width as f64
                    || local[1] >= area.height as f64
                {
                    point
                } else {
                    let source = lens_profile::correction_source(
                        calibration,
                        self.scales,
                        area.width as f64,
                        area.height as f64,
                        local,
                        1,
                    );
                    [
                        source[0].clamp(0.0, (area.width - 1) as f64) + area.left as f64,
                        source[1].clamp(0.0, (area.height - 1) as f64) + area.top as f64,
                    ]
                }
            }
            Optics::Identity => point,
        };
        let source = [
            (point[0] - self.crop.x as f64 + 0.5) / self.crop.w as f64,
            (point[1] - self.crop.y as f64 + 0.5) / self.crop.h as f64,
        ];
        source
            .iter()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
            .then_some(source.map(|v| v as f32))
    }
}

/// One immutable gesture batch; JSON null preserves each unmapped point's
/// position, allowing hosts to break a stroke across an unpaintable surround.
pub fn map_removal_display_points(
    raw: &RawImage,
    model: &AdjustmentModel,
    request: &str,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        schema: u32,
        points: Vec<[f32; 2]>,
        /// When supplied, points refer to the cropped result. These are the
        /// actual oriented buffer dimensions BEFORE the user's crop stage.
        #[serde(default)]
        crop_input_size: Option<[u32; 2]>,
    }
    let request: Request = serde_json::from_str(request).map_err(|e| e.to_string())?;
    if request.schema != 1 {
        return Err("removal geometry: unsupported request schema".into());
    }
    if request
        .crop_input_size
        .is_some_and(|size| size.contains(&0))
    {
        return Err("removal geometry: crop input dimensions must be nonzero".into());
    }
    let map = RemovalGeometry::for_frame(raw, model, request.crop_input_size)?;
    let points: Vec<_> = request
        .points
        .into_iter()
        .map(|point| {
            let point = match request.crop_input_size {
                Some(size) => crate::stages::crop::map_output_uv(&model.crop, size, point),
                None => Some(point),
            };
            point.and_then(|point| map.source(point))
        })
        .collect();
    serde_json::to_string(&serde_json::json!({"source_size":map.source_size(),
        "points":points }))
    .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "removal_geometry_tests.rs"]
mod tests;
