use crate::{
    models::{load_verified, output_f32, Model},
    valid_floats, OrtRuntime, RemovalRunOptions, Result,
};
use ort::{session::Session, value::Tensor};
use std::path::Path;

/// One retained CPU reconstruction session, used only while authoring a patch.
pub struct RemovalReconstructor {
    session: Session,
    digest: raw_core::types::accepted_removal::ContentDigest,
}

impl RemovalReconstructor {
    pub fn load(directory: &Path, runtime: &OrtRuntime) -> Result<Self> {
        let (session, digest) = load_verified(Model::Lama, directory, runtime)?;
        Ok(Self { session, digest })
    }

    pub fn model_digest(&self) -> &raw_core::types::accepted_removal::ContentDigest {
        &self.digest
    }

    /// Prepared pinned-side sRGB CHW guide and binary generation hole. Returns the
    /// model's coarse display guide; raw-core transfers native scene donors.
    pub fn generate(
        &mut self,
        rgb: &[f32],
        hole: &[f32],
        cancel: &RemovalRunOptions,
    ) -> Result<Vec<f32>> {
        let side =
            raw_core::types::removal_models::EXPERIMENTAL_REMOVAL_MODELS[0].native_side as usize;
        let plane = side * side;
        valid_floats(rgb, 3 * plane, 0.0, 1.0)?;
        valid_floats(hole, plane, 0.0, 1.0)?;
        if hole.iter().any(|v| *v != 0.0 && *v != 1.0) || !hole.contains(&1.0) {
            return Err(crate::RemovalInferenceError::Input(
                "generation requires a nonempty binary hole".into(),
            ));
        }
        let input: Vec<f32> = rgb
            .iter()
            .enumerate()
            .map(|(i, value)| value * (1.0 - hole[i % plane]))
            .chain(hole.iter().copied())
            .collect();
        let outputs = self.session.run_with_options(
            ort::inputs!["masked_image_and_mask" => Tensor::from_array(([1,4,side as i64,side as i64], input))?],
            cancel,
        )?;
        let result = output_f32(&outputs, "generated_rgb", &[1, 3, side as i64, side as i64])?;
        valid_floats(&result, 3 * plane, 0.0, 1.0)?;
        Ok(result)
    }
}
