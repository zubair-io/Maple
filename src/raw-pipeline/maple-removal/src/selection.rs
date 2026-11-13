use crate::{
    models::{load, output_f32, Model},
    valid_floats, OrtRuntime, RemovalInferenceError, RemovalRunOptions, Result,
};
use ort::{session::Session, value::Tensor};
use raw_core::{
    stages::removal_smart::{
        candidate_choice_json, context_identity, mask_from_logits_json, model_prompts_json,
    },
    types::accepted_removal::{ContentDigest, SourceAnchor},
};
use std::path::Path;

/// Immutable embedding from one fixed photographic context, never a grade.
pub struct SelectionEmbedding {
    context: ContentDigest,
    values: Vec<f32>,
}

/// Retained encoder/decoder. Refinement reuses the immutable source embedding.
pub struct SmartSelector {
    encoder: Session,
    decoder: Session,
}

#[derive(serde::Deserialize)]
struct Prompts {
    points: Vec<[f32; 2]>,
    labels: Vec<i8>,
}

struct Candidates {
    logits: Vec<f32>,
    scores: Vec<f32>,
    low: Vec<f32>,
}

const NO_CANDIDATE: &str = "smart selection: no candidate honors the positive and negative prompts";

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
        let context = context_identity(source, request).map_err(RemovalInferenceError::Input)?;
        valid_floats(rgb, 3 * 1024 * 1024, 0.0, 255.0)?;
        let outputs = self.encoder.run_with_options(
            ort::inputs!["image" => Tensor::from_array(([1,3,1024,1024], rgb.to_vec()))?],
            cancel,
        )?;
        Ok(SelectionEmbedding {
            context,
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
        if context_identity(source, request).map_err(RemovalInferenceError::Input)?
            != embedding.context
        {
            return Err(RemovalInferenceError::Input(
                "stale selection embedding".into(),
            ));
        }
        let initial = self.candidates(embedding, request, None, cancel)?;
        match candidate_choice_json(request, &initial.logits, &initial.scores) {
            Ok(_) => {
                return mask_from_logits_json(request, &initial.logits, &initial.scores)
                    .map_err(RemovalInferenceError::Input)
            }
            Err(message) if message == NO_CANDIDATE => (),
            Err(message) => return Err(RemovalInferenceError::Input(message)),
        }
        // #3941: one bounded mask-conditioned pass for each actual initial
        // candidate. Prompts stay unchanged and admission stays strict. Rebuild
        // from this request, never prior editor state, so undo/redo is exact.
        let mut best: Option<(f32, Vec<u8>)> = None;
        for seed in initial.low.chunks_exact(256 * 256) {
            let refined = self.candidates(embedding, request, Some(seed), cancel)?;
            match candidate_choice_json(request, &refined.logits, &refined.scores) {
                Ok(choice)
                    if best
                        .as_ref()
                        .is_none_or(|(score, _)| refined.scores[choice] > *score) =>
                {
                    let mask = mask_from_logits_json(request, &refined.logits, &refined.scores)
                        .map_err(RemovalInferenceError::Input)?;
                    best = Some((refined.scores[choice], mask));
                }
                Ok(_) => (),
                Err(message) if message == NO_CANDIDATE => (),
                Err(message) => return Err(RemovalInferenceError::Input(message)),
            }
        }
        best.map(|(_, mask)| mask)
            .ok_or_else(|| RemovalInferenceError::Input(NO_CANDIDATE.into()))
    }

    fn candidates(
        &mut self,
        embedding: &SelectionEmbedding,
        request: &str,
        mask: Option<&[f32]>,
        cancel: &RemovalRunOptions,
    ) -> Result<Candidates> {
        let prepared = model_prompts_json(request).map_err(RemovalInferenceError::Input)?;
        let prompts: Prompts = serde_json::from_str(&prepared)
            .map_err(|e| RemovalInferenceError::Input(e.to_string()))?;
        let count = prompts.labels.len();
        let outputs = self.decoder.run_with_options(ort::inputs![
            "image_embeddings" => Tensor::from_array(([1,256,64,64], embedding.values.clone()))?,
            "point_coords" => Tensor::from_array(([1,count,2], prompts.points.into_iter().flatten().collect::<Vec<_>>()))?,
            "point_labels" => Tensor::from_array(([1,count], prompts.labels.into_iter().map(f32::from).collect::<Vec<_>>()))?,
            "mask_input" => Tensor::from_array(([1,1,256,256], mask.map_or_else(|| vec![0.0_f32;256*256], <[f32]>::to_vec)))?,
            "has_mask_input" => Tensor::from_array(([1], vec![if mask.is_some() { 1.0_f32 } else { 0.0_f32 }]))?,
            "orig_im_size" => Tensor::from_array(([2], vec![1024.0_f32;2]))?,
        ], cancel)?;
        let logits = output_f32(&outputs, "masks", &[1, 4, 1024, 1024])?;
        let scores = output_f32(&outputs, "iou_predictions", &[1, 4])?;
        let low = output_f32(&outputs, "low_res_masks", &[1, 4, 256, 256])?;
        Ok(Candidates {
            logits,
            scores,
            low,
        })
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
        assert!(context_identity(&source, request).is_ok());
        let wrong = SourceAnchor {
            width: 512,
            ..source
        };
        assert!(context_identity(&wrong, request).is_err());
        assert!(context_identity(&wrong, &request.replace("\"label\":1", "\"label\":0")).is_err());
    }
}
