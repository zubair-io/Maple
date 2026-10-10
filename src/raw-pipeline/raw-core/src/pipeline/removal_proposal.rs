//! Join fixed RAW context, inference tensors and durable patches (#3941 / #3955).
//! This runs on explicit authoring actions, never the slider chain. Model/photo
//! qualification remains a separate release gate; no model runs inside raw-core.
use crate::stages::removal_generation::{self, GenerationMaskRequest};
use crate::{
    image::{ColorSpace, Image},
    types::{
        accepted_removal::{ContentDigest, SourceAnchor},
        InpaintPatch,
    },
    view::{agx, encode},
};
use serde::Deserialize;

const SIDE: usize = 1024;
const PLANE: usize = SIDE * SIDE;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: u32,
    source: SourceAnchor,
    masks: GenerationMaskRequest,
    model: ContentDigest,
    model_version: String,
}

/// Immutable proposal preparation. One exact encoding recipe and coverage
/// belong to this context; a later inference result cannot change either.
pub struct PreparedRemovalGeneration {
    request: String,
    prior: String,
    intent: Vec<u8>,
    window: crate::types::accepted_removal::NativeWindow,
    source: SourceAnchor,
    coverage: Vec<f32>,
    native_scene: Vec<[f32; 3]>,
    native_guide: Vec<[f32; 3]>,
    rgb: Vec<f32>,
    hole: Vec<f32>,
}

impl PreparedRemovalGeneration {
    /// `scene` is the exact bounded calibration context including all earlier
    /// accepted replacements. Hosts bind that context to `source` before calling.
    pub fn prepare(
        request: &str,
        prior: &str,
        scene: &[f32],
        intent: &[u8],
        protected: &[u8],
    ) -> Result<Self, String> {
        let request: Request = serde_json::from_str(request).map_err(|e| e.to_string())?;
        if request.schema != 1
            || request.model_version.is_empty()
            || request.model_version.len() > 256
        {
            return Err("removal generation: invalid request schema or model version".into());
        }
        request.source.original.validate()?;
        request.source.decode.validate()?;
        request.model.validate()?;
        let earlier = crate::types::inpaint::decode_removals(prior)?;
        if earlier.iter().any(|removal| {
            removal.accepted.as_ref().is_none_or(|accepted| {
                accepted.source != request.source
                    || accepted.plate
                        != crate::types::accepted_removal::RemovalPlate::LinearCalibrationV1
            })
        }) {
            return Err("removal generation: prior source or plate is incompatible".into());
        }
        let mask = super::removal_mask_from_bytes(intent)?;
        if (mask.source_width, mask.source_height) != (request.source.width, request.source.height)
        {
            return Err("removal generation: intent source geometry changed".into());
        }
        let protected_mask = if protected.is_empty() {
            None
        } else {
            Some(super::removal_mask_from_bytes(protected)?)
        };
        let masks = removal_generation::prepare(&request.masks, &mask, protected_mask.as_ref())?;
        let window = masks.window;
        let (w, h) = (window.width as usize, window.height as usize);
        if scene.len() != w * h * 3 {
            return Err("removal generation: native context dimensions changed".into());
        }
        let scene: Vec<[f32; 3]> = scene.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
        let native_guide = photographic_guide(&scene, window.width, window.height)?;
        let mut rgb = vec![0.0; 3 * PLANE];
        let mut hole = vec![0.0; PLANE];
        for y in 0..SIDE {
            for x in 0..SIDE {
                let index = y * SIDE + x;
                let (source, selected) = area_sample(&native_guide, &masks.hole, w, h, x, y);
                for channel in 0..3 {
                    rgb[channel * PLANE + index] = source[channel];
                }
                hole[index] = f32::from(selected) / 255.0;
            }
        }
        if hole.iter().all(|value| *value == 1.0) {
            return Err("removal generation: no known context remains".into());
        }
        let recipe = serde_json::to_vec(&serde_json::json!({
            "schema":1,"plate":"linear-calibration-v1",
            "model_guide":"agx-neutral-srgb-v1","model_input_resize":"area-native-to-1024-v1",
            "native_transfer":"rgb-guided-patchmatch-v1","masks":request.masks,
            "protection":ContentDigest::for_bytes(protected),"model":request.model,
        }))
        .map_err(|e| e.to_string())?;
        let metadata = serde_json::json!({
            "plate":"linear-calibration-v1","source":request.source,
            "patch_window":window,"context_window":window,"model":request.model,
            "recipe":ContentDigest::for_bytes(&recipe),"model_version":request.model_version,
            "bake":{"temp":6500,"tint":0,"ev":0},
        })
        .to_string();
        Ok(Self {
            request: metadata,
            prior: prior.into(),
            intent: intent.into(),
            window,
            source: request.source,
            coverage: masks.coverage,
            native_scene: scene,
            native_guide,
            rgb,
            hole,
        })
    }

    pub fn request(&self) -> &str {
        &self.request
    }
    pub fn rgb(&self) -> &[f32] {
        &self.rgb
    }
    pub fn hole(&self) -> &[f32] {
        &self.hole
    }

    /// Decode the model's native CHW result, then use the normal fp16 codec and
    /// complete accepted-record verifier. Every selected pixel stays opaque;
    /// untouched RGB is zeroed so unrelated model pixels cannot affect storage.
    pub fn finish(
        &self,
        generated: &[f32],
        cancel: crate::cancel::CancelToken<'_>,
    ) -> Result<Vec<u8>, String> {
        if generated.len() != 3 * PLANE || generated.iter().any(|v| !(0.0..=1.0).contains(v)) {
            return Err("removal generation: invalid reconstruction tensor".into());
        }
        let (w, h) = (self.window.width as usize, self.window.height as usize);
        let model: Vec<[f32; 3]> = (0..PLANE)
            .map(|index| {
                [
                    generated[index],
                    generated[PLANE + index],
                    generated[2 * PLANE + index],
                ]
            })
            .collect();
        let mut guide = self.native_guide.clone();
        for y in 0..h {
            for x in 0..w {
                let index = y * w + x;
                if self.coverage[index] > 0.0 {
                    guide[index] = bilinear_sample(&model, x, y, w, h);
                }
            }
        }
        let hole: Vec<u8> = self
            .coverage
            .iter()
            .map(|coverage| u8::from(*coverage > 0.0))
            .collect();
        let transferred = super::guided_native_texture_transfer(
            &self.native_scene,
            &guide,
            &hole,
            self.window.width,
            self.window.height,
            cancel,
        )?;
        if cancel.is_cancelled() {
            return Err("guided removal: cancelled".into());
        }
        let pixels = transferred
            .into_iter()
            .zip(&self.coverage)
            .map(
                |(pixel, alpha)| {
                    if *alpha == 0.0 {
                        [0.0; 3]
                    } else {
                        pixel
                    }
                },
            )
            .collect();
        let region = self.window.region(self.source.width, self.source.height);
        let patch = super::patch_to_bytes(&InpaintPatch {
            width: self.window.width,
            height: self.window.height,
            origin: [region[0], region[1]],
            extent: [region[2], region[3]],
            pixels,
            coverage: self.coverage.clone(),
        })?;
        super::prepare_accepted_removal(&self.request, &self.prior, &self.intent, &patch)?;
        Ok(patch)
    }
}

fn photographic_guide(
    scene: &[[f32; 3]],
    width: u32,
    height: u32,
) -> Result<Vec<[f32; 3]>, String> {
    let mut image = Image {
        width,
        height,
        pixels: scene.to_vec(),
        space: ColorSpace::SceneLinearRec2020,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.0,
    };
    agx::apply(&mut image, 0.0, 0.0);
    encode::rec2020_to_srgb(&mut image);
    encode::srgb_gamma_encode(&mut image);
    if image
        .pixels
        .iter()
        .flatten()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("removal generation: photographic model guide is outside sRGB".into());
    }
    Ok(image.pixels)
}

fn area_sample(
    guide: &[[f32; 3]],
    hole: &[u8],
    width: usize,
    height: usize,
    x: usize,
    y: usize,
) -> ([f32; 3], u8) {
    let x0 = x * width / SIDE;
    let y0 = y * height / SIDE;
    let x1 = ((x + 1) * width).div_ceil(SIDE).max(x0 + 1).min(width);
    let y1 = ((y + 1) * height).div_ceil(SIDE).max(y0 + 1).min(height);
    let mut total = [0.0; 3];
    let mut count = 0.0;
    let mut selected = 0;
    for sy in y0..y1 {
        for sx in x0..x1 {
            let index = sy * width + sx;
            for channel in 0..3 {
                total[channel] += guide[index][channel];
            }
            count += 1.0;
            selected = selected.max(hole[index]);
        }
    }
    (total.map(|value| value / count), selected)
}

fn bilinear_sample(
    image: &[[f32; 3]],
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> [f32; 3] {
    let fx = ((x as f32 + 0.5) * SIDE as f32 / width as f32 - 0.5).clamp(0.0, (SIDE - 1) as f32);
    let fy = ((y as f32 + 0.5) * SIDE as f32 / height as f32 - 0.5).clamp(0.0, (SIDE - 1) as f32);
    let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(SIDE - 1), (y0 + 1).min(SIDE - 1));
    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
    std::array::from_fn(|channel| {
        let upper =
            image[y0 * SIDE + x0][channel] * (1.0 - tx) + image[y0 * SIDE + x1][channel] * tx;
        let lower =
            image[y1 * SIDE + x0][channel] * (1.0 - tx) + image[y1 * SIDE + x1][channel] * tx;
        upper * (1.0 - ty) + lower * ty
    })
}

#[cfg(test)]
#[path = "removal_proposal_tests.rs"]
mod tests;
