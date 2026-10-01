//! Join fixed RAW context, inference tensors and durable patches (#3941 / #3955).
//! This runs on explicit authoring actions, never the slider chain. Model/photo
//! qualification remains a separate release gate; no model runs inside raw-core.
use super::RemovalModelEncoding;
use crate::stages::removal_generation::{self, GenerationMaskRequest};
use crate::types::{
    accepted_removal::{ContentDigest, SourceAnchor},
    InpaintPatch,
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
    encoding: RemovalModelEncoding,
    window: crate::types::accepted_removal::NativeWindow,
    source: SourceAnchor,
    coverage: Vec<f32>,
    rgb: Vec<f32>,
    hole: Vec<f32>,
}

/// Reflect-101 padding keeps source pixels at native scale, including 1-pixel
/// axes. The identical lookup pads RGB and the binary hole; the padded fringe
/// is never written into the native patch or durable mask.
fn reflected(index: usize, length: usize) -> usize {
    if length == 1 {
        return 0;
    }
    let period = 2 * (length - 1);
    let index = index % period;
    if index < length {
        index
    } else {
        period - index
    }
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
        let encoding = RemovalModelEncoding::fit(&scene).map_err(|e| e.to_string())?;
        let encoded = encoding.encode(&scene).map_err(|e| e.to_string())?;
        let mut rgb = vec![0.0; 3 * PLANE];
        let mut hole = vec![0.0; PLANE];
        for y in 0..SIDE {
            for x in 0..SIDE {
                let source = reflected(y, h) * w + reflected(x, w);
                let index = y * SIDE + x;
                for channel in 0..3 {
                    rgb[channel * PLANE + index] = encoded[source][channel];
                }
                hole[index] = f32::from(masks.hole[source]) / 255.0;
            }
        }
        if hole.iter().all(|value| *value == 1.0) {
            return Err("removal generation: no known context remains".into());
        }
        let recipe = serde_json::to_vec(&serde_json::json!({
            "schema":1,"plate":"linear-calibration-v1","encoding":encoding,
            "padding":"reflect-101-native-1024-v1","masks":request.masks,
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
            encoding,
            window,
            source: request.source,
            coverage: masks.coverage,
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
    pub fn finish(&self, generated: &[f32]) -> Result<Vec<u8>, String> {
        if generated.len() != 3 * PLANE || generated.iter().any(|v| !(0.0..=1.0).contains(v)) {
            return Err("removal generation: invalid reconstruction tensor".into());
        }
        let (w, h) = (self.window.width as usize, self.window.height as usize);
        let model: Vec<[f32; 3]> = (0..w * h)
            .map(|index| {
                let index = index / w * SIDE + index % w;
                [
                    generated[index],
                    generated[PLANE + index],
                    generated[2 * PLANE + index],
                ]
            })
            .collect();
        let decoded = self.encoding.decode(&model).map_err(|e| e.to_string())?;
        let pixels = decoded
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

#[cfg(test)]
#[path = "removal_proposal_tests.rs"]
mod tests;
