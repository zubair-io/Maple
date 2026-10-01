use crate::{
    models::{load, output_f32, Model},
    valid_floats, OrtRuntime, RemovalRunOptions, Result,
};
use ort::{session::Session, value::Tensor};
use std::path::Path;

/// One retained CPU reconstruction session, used only while authoring a patch.
pub struct RemovalReconstructor {
    session: Session,
}

impl RemovalReconstructor {
    pub fn load(directory: &Path, runtime: &OrtRuntime) -> Result<Self> {
        Ok(Self {
            session: load(Model::Lama, directory, runtime)?,
        })
    }

    /// Prepared photographic CHW RGB and binary generation hole, native 1024².
    /// Returns model-domain CHW RGB; raw-core owns inverse encoding and blend.
    pub fn generate(
        &mut self,
        rgb: &[f32],
        hole: &[f32],
        cancel: &RemovalRunOptions,
    ) -> Result<Vec<f32>> {
        let plane = 1024 * 1024;
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
            ort::inputs!["masked_image_and_mask" => Tensor::from_array(([1,4,1024,1024], input))?],
            cancel,
        )?;
        let result = output_f32(&outputs, "generated_rgb", &[1, 3, 1024, 1024])?;
        valid_floats(&result, 3 * plane, 0.0, 1.0)?;
        Ok(result)
    }
}
