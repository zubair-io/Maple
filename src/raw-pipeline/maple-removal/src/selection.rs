use crate::{
    models::{load, output_f32, Model},
    valid_floats, OrtRuntime, RemovalInferenceError, RemovalRunOptions, Result,
};
use ort::{session::Session, value::Tensor};
use raw_core::{
    stages::removal_smart::{mask_from_logits_json, model_prompts_json, SmartMaskRequest},
    types::accepted_removal::SourceAnchor,
};
use std::path::Path;

/// Immutable embedding from one fixed photographic context, never a grade.
pub struct SelectionEmbedding {
    source: SourceAnchor,
    geometry: [u32; 8],
    values: Vec<f32>,
}

/// Retained encoder/decoder. Refinement reuses the immutable source embedding.
pub struct SmartSelector {
    encoder: Session,
    decoder: Session,
}

fn geometry(source: &SourceAnchor, request: &str) -> Result<[u32; 8]> {
    model_prompts_json(request).map_err(RemovalInferenceError::Input)?;
    let parsed: SmartMaskRequest =
        serde_json::from_str(request).map_err(|e| RemovalInferenceError::Input(e.to_string()))?;
    source
        .original
        .validate()
        .map_err(RemovalInferenceError::Input)?;
    source
        .decode
        .validate()
        .map_err(RemovalInferenceError::Input)?;
    if source.width != parsed.source_width || source.height != parsed.source_height {
        return Err(RemovalInferenceError::Input(
            "selection source geometry mismatch".into(),
        ));
    }
    Ok([
        source.width,
        source.height,
        parsed.window.x,
        parsed.window.y,
        parsed.window.width,
        parsed.window.height,
        parsed.input_width,
        parsed.input_height,
    ])
}

#[derive(serde::Deserialize)]
struct Prompts {
    points: Vec<[f32; 2]>,
    labels: Vec<i8>,
}

impl SmartSelector {
    pub fn load(directory: &Path, runtime: &OrtRuntime) -> Result<Self> {
        Ok(Self {
            encoder: load(Model::Encoder, directory, runtime)?,
            decoder: load(Model::Decoder, directory, runtime)?,
        })
    }

    /// Aspect-preserved/padded or native-window RGB, CHW float 0..255.
    pub fn encode(
        &mut self,
        source: &SourceAnchor,
        request: &str,
        rgb: &[f32],
        cancel: &RemovalRunOptions,
    ) -> Result<SelectionEmbedding> {
        let geometry = geometry(source, request)?;
        valid_floats(rgb, 3 * 1024 * 1024, 0.0, 255.0)?;
        let outputs = self.encoder.run_with_options(
            ort::inputs!["image" => Tensor::from_array(([1,3,1024,1024], rgb.to_vec()))?],
            cancel,
        )?;
        Ok(SelectionEmbedding {
            source: source.clone(),
            geometry,
            values: output_f32(&outputs, "image_embeddings", &[1, 256, 64, 64])?,
        })
    }

    /// Returns native MIMF intent only after shared prompt-satisfaction checks.
    /// Rejected candidates preserve the caller's previous selection.
    pub fn refine(
        &mut self,
        source: &SourceAnchor,
        embedding: &SelectionEmbedding,
        request: &str,
        cancel: &RemovalRunOptions,
    ) -> Result<Vec<u8>> {
        if source != &embedding.source || geometry(source, request)? != embedding.geometry {
            return Err(RemovalInferenceError::Input(
                "stale selection embedding".into(),
            ));
        }
        let (logits, scores) = self.candidates(embedding, request, cancel)?;
        mask_from_logits_json(request, &logits, &scores).map_err(RemovalInferenceError::Input)
    }

    fn candidates(
        &mut self,
        embedding: &SelectionEmbedding,
        request: &str,
        cancel: &RemovalRunOptions,
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let prepared = model_prompts_json(request).map_err(RemovalInferenceError::Input)?;
        let prompts: Prompts = serde_json::from_str(&prepared)
            .map_err(|e| RemovalInferenceError::Input(e.to_string()))?;
        let count = prompts.labels.len();
        let outputs = self.decoder.run_with_options(ort::inputs![
            "image_embeddings" => Tensor::from_array(([1,256,64,64], embedding.values.clone()))?,
            "point_coords" => Tensor::from_array(([1,count,2], prompts.points.into_iter().flatten().collect::<Vec<_>>()))?,
            "point_labels" => Tensor::from_array(([1,count], prompts.labels.into_iter().map(f32::from).collect::<Vec<_>>()))?,
            "mask_input" => Tensor::from_array(([1,1,256,256], vec![0.0_f32;256*256]))?,
            "has_mask_input" => Tensor::from_array(([1], vec![0.0_f32]))?,
            "orig_im_size" => Tensor::from_array(([2], vec![1024.0_f32;2]))?,
        ], cancel)?;
        let logits = output_f32(&outputs, "masks", &[1, 4, 1024, 1024])?;
        let scores = output_f32(&outputs, "iou_predictions", &[1, 4])?;
        // Validate even unused low-resolution output before accepting the run.
        output_f32(&outputs, "low_res_masks", &[1, 4, 256, 256])?;
        Ok((logits, scores))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedding_geometry_rejects_wrong_source_and_preserves_prompt_contract() {
        let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(b"fixture");
        let source = SourceAnchor {
            original: digest.clone(),
            decode: digest,
            width: 1024,
            height: 1024,
        };
        let request = r#"{"schema":1,"source_width":1024,"source_height":1024,"window":{"x":0,"y":0,"width":1024,"height":1024},"input_width":1024,"input_height":1024,"prompts":[{"position":[0.5,0.5],"label":1}]}"#;
        assert_eq!(
            geometry(&source, request).unwrap(),
            [1024, 1024, 0, 0, 1024, 1024, 1024, 1024]
        );
        let wrong = SourceAnchor {
            width: 512,
            ..source
        };
        assert!(geometry(&wrong, request).is_err());
        assert!(geometry(&wrong, &request.replace("\"label\":1", "\"label\":0")).is_err());
    }
}
