//! ALIKED detector session (ONNX Runtime via `ort`).
//!
//! Thin, validated wrapper around the pinned ALIKED export (see
//! `maple-pano/models.toml` for the exact interface): all numeric
//! pre/post-processing lives in the pure [`super::preprocess`] /
//! [`super::postprocess`] modules; this file only owns the session,
//! tensor plumbing, and output validation.

use std::path::PathBuf;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

// CoreML EP types — only needed for the iOS execution-provider registration
// (M6-C, #1251). The imports are gated so the host/macOS build does not pull
// in any CoreML dependency.
#[cfg(target_os = "ios")]
use ort::execution_providers::coreml::{
    CoreMLComputeUnits, CoreMLExecutionProvider, CoreMLModelFormat,
};

use crate::features::postprocess::{select_keypoints, KeypointFilter};
use crate::features::preprocess::letterbox_to_chw;
use crate::features::{FeatureSet, Keypoint, LinearRgbFrame};
use crate::models::{MlError, ModelDir, OrtRuntime};

/// Output head names baked into the pinned export (ajuric/ikeboo
/// exporter, `output_names=["keypoints", "descriptors", "scores"]`).
const OUT_KEYPOINTS: &str = "keypoints";
const OUT_DESCRIPTORS: &str = "descriptors";
const OUT_SCORES: &str = "scores";

/// Detector configuration. The derived `Default` delegates to
/// [`KeypointFilter::default`] (score > 0.2, no extra NMS/cap on top of
/// the graph's own radius-2 NMS + top-2000) and lets ONNX Runtime pick
/// the intra-op thread count.
#[derive(Debug, Clone, Default)]
pub struct DetectorOptions {
    /// Keypoint selection applied to the graph's raw top-k output.
    pub filter: KeypointFilter,
    /// Intra-op thread count for the session. `None` lets ONNX Runtime
    /// pick (its default heuristic uses the physical core count).
    pub intra_threads: Option<usize>,
    /// Request the CoreML Execution Provider (M6-C, #1251).
    ///
    /// When `true` and compiled for iOS (`target_os = "ios"`), the
    /// CoreML EP is registered ahead of the default CPU provider so that
    /// ANE/GPU-eligible ops run on silicon; unsupported ops (none expected
    /// for ALIKED on iOS 17+) fall back to ORT-CPU automatically. On
    /// macOS the field is ignored — the macOS path is CPU-ORT and must
    /// not be perturbed (parity-verified; see M6-C invariant in #1251).
    ///
    /// The EP is registered in "graceful" mode (default, not
    /// `error_on_failure`): if CoreML is unavailable at runtime the
    /// session init continues with ORT-CPU and logs a warning rather than
    /// failing hard. ANE speedup is unvalidated on-device — pending M6-E.
    pub use_coreml: bool,
}

/// ALIKED keypoint/descriptor detector. Construct once with
/// [`AlikedDetector::load`], reuse across frames (`detect` takes `&mut
/// self` because ONNX Runtime sessions are stateful at the API level).
pub struct AlikedDetector {
    session: Session,
    model_path: PathBuf,
    input_name: String,
    /// Static square input side `S` read from the graph.
    input_size: u32,
    options: DetectorOptions,
}

impl AlikedDetector {
    /// Load the verified ALIKED model from `models`.
    ///
    /// On iOS with `options.use_coreml = true` the CoreML Execution
    /// Provider is registered before the default CPU provider
    /// (`MLProgram` format, `All` compute units) so that ANE/GPU-eligible
    /// ops run on Apple silicon. ALIKED has full op coverage on iOS 17+
    /// (`GridSample` requires CoreML 7 / iOS 17; the build sets
    /// `IPHONEOS_DEPLOYMENT_TARGET=17.0`). On macOS the option is ignored
    /// — the macOS path is CPU-ORT (parity-verified, must not change).
    ///
    /// CoreML EP is registered in "graceful" mode: if registration or
    /// model compilation fails at runtime (older OS, EP unavailable, etc.)
    /// the session continues with ORT-CPU and logs a warning; it never
    /// crashes or returns a hard error on CoreML failure alone.
    ///
    /// Runs the ONNX Runtime pre-flight first, so a machine without the
    /// dylib gets a typed [`MlError::RuntimeUnavailable`] instead of
    /// `ort`'s load-dynamic panic.
    ///
    /// M6-E: ANE speedup is unvalidated on-device — pending real-device
    /// measurement (estimated ~25s→~5s on A-series). The simulator has no
    /// ANE; ORT logs the CoreML EP status and runs the graph on CPU-ORT —
    /// a logged fallback, never silent.
    pub fn load(models: &ModelDir, options: DetectorOptions) -> Result<Self, MlError> {
        OrtRuntime::preflight(None)?;
        let mut builder = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
            .map_err(|e| MlError::Runtime(format!("session builder: {e}")))?;
        if let Some(threads) = options.intra_threads {
            builder = builder
                .with_intra_threads(threads)
                .map_err(|e| MlError::Runtime(format!("intra threads: {e}")))?;
        }
        // M6-C (#1251): CoreML EP — iOS only. macOS stays on CPU-ORT (the
        // macOS path is parity-verified against ACR references and must not
        // be perturbed). The EP is registered in "graceful" mode (the
        // default, i.e. not error_on_failure): unsupported ops are
        // partitioned onto CPU-ORT automatically, and an EP-registration
        // failure (older OS, EP unavailable) is logged by ORT as a warning
        // and then falls back to CPU-ORT — not a silent fallback. The
        // session never returns a hard error on a CoreML failure alone.
        #[cfg(target_os = "ios")]
        if options.use_coreml {
            builder = builder
                .with_execution_providers([CoreMLExecutionProvider::default()
                    .with_model_format(CoreMLModelFormat::MLProgram)
                    .with_compute_units(CoreMLComputeUnits::All)
                    .build()])
                .map_err(|e| MlError::Runtime(format!("CoreML EP registration: {e}")))?;
        }
        let session = builder
            .commit_from_file(&models.aliked)
            .map_err(|e| MlError::Runtime(format!("loading {}: {e}", models.aliked.display())))?;

        let (input_name, input_size) = validate_interface(&session, &models.aliked)?;
        Ok(Self {
            session,
            model_path: models.aliked.clone(),
            input_name,
            input_size,
            options,
        })
    }

    /// The static square input size `S` the graph was exported with
    /// (1280 for the pinned model).
    pub fn input_size(&self) -> u32 {
        self.input_size
    }

    /// Detect keypoints on a scene-linear frame. Returns a [`FeatureSet`]
    /// with keypoints in source continuous pixel coordinates, descending
    /// score order, descriptors row-aligned with the keypoints.
    pub fn detect(&mut self, frame: &LinearRgbFrame) -> Result<FeatureSet, MlError> {
        let (letterbox, chw) = letterbox_to_chw(frame, self.input_size);
        let s = self.input_size as usize;
        let input = Tensor::from_array(([1_usize, 3, s, s], chw))
            .map_err(|e| MlError::Inference(format!("building input tensor: {e}")))?;
        // Local error builder: `outputs` keeps `self.session` mutably
        // borrowed, so a `&self` method is unusable past this point.
        let model_path = self.model_path.clone();
        let ierr = |reason: String| MlError::ModelInterface {
            path: model_path.clone(),
            reason,
        };
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => input])
            .map_err(|e| MlError::Inference(format!("ALIKED inference: {e}")))?;

        // --- keypoints [N, 2] (optionally [1, N, 2]) -------------------
        let kpts_value = outputs
            .get(OUT_KEYPOINTS)
            .ok_or_else(|| ierr(format!("output `{OUT_KEYPOINTS}` is missing")))?;
        let (kp_shape, kp_data) = kpts_value
            .try_extract_tensor::<f32>()
            .map_err(|e| ierr(format!("extracting `{OUT_KEYPOINTS}`: {e}")))?;
        let kp_dims = squeeze_leading_batch(kp_shape);
        if kp_dims.len() != 2 || kp_dims[1] != 2 {
            return Err(ierr(format!(
                "`{OUT_KEYPOINTS}` has shape {kp_shape:?}, expected [N, 2]"
            )));
        }
        let n = kp_dims[0] as usize;

        // --- scores [N] (optionally [1, N]) ----------------------------
        let scores_value = outputs
            .get(OUT_SCORES)
            .ok_or_else(|| ierr(format!("output `{OUT_SCORES}` is missing")))?;
        let (sc_shape, sc_data) = scores_value
            .try_extract_tensor::<f32>()
            .map_err(|e| ierr(format!("extracting `{OUT_SCORES}`: {e}")))?;
        let sc_dims = squeeze_leading_batch(sc_shape);
        if sc_dims.len() != 1 || sc_dims[0] as usize != n {
            return Err(ierr(format!(
                "`{OUT_SCORES}` has shape {sc_shape:?}, expected [{n}]"
            )));
        }

        // --- descriptors [N, D] (optionally [1, N, D]) ------------------
        let desc_value = outputs
            .get(OUT_DESCRIPTORS)
            .ok_or_else(|| ierr(format!("output `{OUT_DESCRIPTORS}` is missing")))?;
        let (de_shape, de_data) = desc_value
            .try_extract_tensor::<f32>()
            .map_err(|e| ierr(format!("extracting `{OUT_DESCRIPTORS}`: {e}")))?;
        let de_dims = squeeze_leading_batch(de_shape);
        if de_dims.len() != 2 || de_dims[0] as usize != n || de_dims[1] < 1 {
            return Err(ierr(format!(
                "`{OUT_DESCRIPTORS}` has shape {de_shape:?}, expected [{n}, D]"
            )));
        }
        let descriptor_dim = de_dims[1] as usize;

        // Map normalized coordinates to source pixels (exact chain — see
        // preprocess module docs), then run the pure selection.
        let mut norm = Vec::with_capacity(n);
        let mut src_xy = Vec::with_capacity(n);
        for i in 0..n {
            let (nx, ny) = (kp_data[i * 2], kp_data[i * 2 + 1]);
            norm.push([nx, ny]);
            let (sx, sy) = letterbox.norm_to_src_px(nx, ny);
            src_xy.push([sx, sy]);
        }
        let selected = select_keypoints(&src_xy, sc_data, &self.options.filter);

        let mut keypoints = Vec::with_capacity(selected.len());
        let mut descriptors = Vec::with_capacity(selected.len() * descriptor_dim);
        let mut norm_keypoints = Vec::with_capacity(selected.len());
        for &i in &selected {
            keypoints.push(Keypoint {
                x: src_xy[i][0],
                y: src_xy[i][1],
                score: sc_data[i],
            });
            descriptors.extend_from_slice(&de_data[i * descriptor_dim..(i + 1) * descriptor_dim]);
            norm_keypoints.push(norm[i]);
        }
        Ok(FeatureSet {
            keypoints,
            descriptors,
            descriptor_dim,
            norm_keypoints,
        })
    }
}

/// Validate the session exposes the pinned export's interface: a single
/// f32 input `[1, 3, S, S]` with static square `S`, plus the three output
/// heads. Returns `(input_name, S)`.
fn validate_interface(session: &Session, path: &std::path::Path) -> Result<(String, u32), MlError> {
    let interface_err = |reason: String| MlError::ModelInterface {
        path: path.to_path_buf(),
        reason,
    };
    let input = session
        .inputs
        .first()
        .ok_or_else(|| interface_err("model has no inputs".into()))?;
    if session.inputs.len() != 1 {
        return Err(interface_err(format!(
            "expected exactly one input, found {}",
            session.inputs.len()
        )));
    }
    let dims: Vec<i64> = match &input.input_type {
        ort::value::ValueType::Tensor { shape, .. } => shape.iter().copied().collect(),
        other => {
            return Err(interface_err(format!(
                "input `{}` is not a tensor ({other:?})",
                input.name
            )));
        }
    };
    // The pinned exports are static-shape (onnxsim-simplified squares).
    // Dynamic-axis ALIKED exports would need stride-aligned sizing logic
    // that nothing exercises today; reject them explicitly so a model
    // swap is a deliberate change here, not a silent semantics shift.
    if dims.len() != 4 || dims[0] != 1 || dims[1] != 3 {
        return Err(interface_err(format!(
            "input `{}` has shape {dims:?}, expected [1, 3, S, S]",
            input.name
        )));
    }
    if dims[2] < 2 || dims[2] != dims[3] {
        return Err(interface_err(format!(
            "input `{}` has shape {dims:?}; the pinned exports use a static square S >= 2 \
             (dynamic-shape exports are not supported — re-pin models.toml deliberately)",
            input.name
        )));
    }
    for name in [OUT_KEYPOINTS, OUT_DESCRIPTORS, OUT_SCORES] {
        if !session.outputs.iter().any(|o| o.name == name) {
            let have: Vec<&str> = session.outputs.iter().map(|o| o.name.as_str()).collect();
            return Err(interface_err(format!(
                "output `{name}` is missing (model outputs: {have:?})"
            )));
        }
    }
    Ok((input.name.clone(), dims[2] as u32))
}

/// Drop a leading batch dimension of exactly 1 (exports vary on whether
/// the batch axis survives the ONNX squeeze).
fn squeeze_leading_batch(shape: &[i64]) -> &[i64] {
    match shape {
        [1, rest @ ..] if !rest.is_empty() => rest,
        s => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squeeze_leading_batch_only_drops_unit_batch() {
        assert_eq!(squeeze_leading_batch(&[1, 2000, 2]), &[2000_i64, 2]);
        assert_eq!(squeeze_leading_batch(&[2000, 2]), &[2000_i64, 2]);
        assert_eq!(squeeze_leading_batch(&[1, 2000]), &[2000_i64]);
        // A genuine batch of 2 is not squeezed away.
        assert_eq!(squeeze_leading_batch(&[2, 2000, 2]), &[2_i64, 2000, 2]);
        // A bare [1] stays (squeezing it would leave rank 0).
        assert_eq!(squeeze_leading_batch(&[1]), &[1_i64]);
    }
}
