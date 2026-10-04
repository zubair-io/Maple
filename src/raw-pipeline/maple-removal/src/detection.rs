use crate::{
    models::{load, output_f32, Model},
    valid_floats, OrtRuntime, RemovalInferenceError, RemovalRunOptions, Result,
};
use ort::{session::Session, value::Tensor};
use std::path::Path;

#[derive(Debug, serde::Serialize)]
pub struct Detection {
    pub class: u8,
    pub bounds: [f32; 4],
    pub score: f32,
}

/// Person proposals only; background/subject classification is host policy.
pub struct PersonDetector {
    session: Session,
}

impl PersonDetector {
    pub fn load(directory: &Path, runtime: &OrtRuntime) -> Result<Self> {
        Ok(Self {
            session: load(Model::Detector, directory, runtime)?,
        })
    }
    /// Upstream 640² square photographic RGB proxy; size is [width, height]
    /// as required by RT-DETR orig_target_sizes. Boxes use source pixels.
    pub fn detect(
        &mut self,
        rgb: &[f32],
        size: [u32; 2],
        cancel: &RemovalRunOptions,
    ) -> Result<Vec<Detection>> {
        self.detect_oriented(rgb, size, 1, cancel)
    }

    /// Native source-framed RGB with the RAW's EXIF tag. The semantic model
    /// sees upright pixels; every returned box remains in native source axes.
    pub fn detect_oriented(
        &mut self,
        rgb: &[f32],
        size: [u32; 2],
        orientation: u16,
        cancel: &RemovalRunOptions,
    ) -> Result<Vec<Detection>> {
        valid_floats(rgb, 3 * 640 * 640, 0.0, 1.0)?;
        let display = raw_core::stages::removal_detection_geometry::upright_size(size, orientation)
            .map_err(RemovalInferenceError::Input)?;
        let input = if orientation == 1 {
            rgb.to_vec()
        } else {
            raw_core::stages::removal_detection_geometry::upright_rgb(rgb, orientation)
                .map_err(RemovalInferenceError::Input)?
        };
        let outputs = self.session.run_with_options(
            ort::inputs![
                "images" => Tensor::from_array(([1,3,640,640], input))?,
                "orig_target_sizes" => Tensor::from_array(([1,2], display.map(i64::from).to_vec()))?,
            ],
            cancel,
        )?;
        let labels = outputs
            .get("labels")
            .ok_or_else(|| RemovalInferenceError::Model("missing labels".into()))?;
        let (shape, labels) = labels.try_extract_tensor::<i64>()?;
        if shape[..] != [1, 300] || labels.iter().any(|v| !(0..80).contains(v)) {
            return Err(RemovalInferenceError::Model("invalid class output".into()));
        }
        let boxes = output_f32(&outputs, "boxes", &[1, 300, 4])?;
        let scores = output_f32(&outputs, "scores", &[1, 300])?;
        valid_floats(&scores, 300, 0.0, 1.0)?;
        labels
            .iter()
            .zip(boxes.chunks_exact(4))
            .zip(scores)
            .map(|((label, bounds), score)| {
                Ok(Detection {
                    class: *label as u8,
                    bounds: raw_core::stages::removal_detection_geometry::source_box(
                        [bounds[0], bounds[1], bounds[2], bounds[3]],
                        size,
                        orientation,
                    )
                    .map_err(RemovalInferenceError::Model)?,
                    score,
                })
            })
            .collect()
    }
}
