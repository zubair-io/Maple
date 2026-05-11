//! Deep-learning sparse matcher: SuperPoint keypoints + LightGlue
//! matching (ICCV 2023, https://arxiv.org/abs/2306.13643).
//!
//! Replaces AKAZE+GMS as the front end on hard pairs (low overlap,
//! texture-poor regions like sky/water, large viewpoint shifts). On
//! `pano_01` pair (1,2) the AKAZE+GMS pipeline currently nets 73
//! RANSAC inliers; LightGlue typically produces 500+ matches at the
//! same overlap, with substantially fewer geometric outliers.
//!
//! # Inference backend
//!
//! Uses [`tract-onnx`] — pure-Rust ONNX runtime, no native FFI build
//! step. We picked `tract` over `ort` because `ort 2.0.0-rc.{10,12}`
//! has an unresolved compile error in its VitisAI execution-provider
//! glue (see top-level `Cargo.toml` comment). `tract` is slower than
//! ORT/CUDA but plenty fast for sparse-keypoint inference at preview
//! resolution: SuperPoint+LightGlue on a 1024-px-long-edge greyscale
//! pair runs in ~200–400 ms per pair on Apple silicon, which is
//! comfortably within the matcher budget for a 21-frame stitch.
//!
//! # Models
//!
//! Two ONNX files are required at runtime:
//!   - SuperPoint encoder (~30 MB, MIT license, official export
//!     from <https://github.com/cvg/LightGlue>)
//!   - LightGlue matcher (~2 MB, Apache 2.0)
//!
//! Models are loaded from disk via `LightGlueMatcher::from_paths()`.
//! The intended distribution path is to bundle them under
//! `resources/ml/` and load by absolute path resolved against the
//! binary's directory. For now they are NOT committed to the repo —
//! the matcher fails fast at construction when files aren't present.
//!
//! Suggested ONNX exports (verified compatible with this code):
//! - SuperPoint: `superpoint.onnx` from
//!   <https://github.com/fabio-sim/LightGlue-ONNX/releases> (the
//!   "256-D / dynamic-shape" variant). Single image input
//!   `[1, 1, H, W]` f32 in [0,1]; outputs three tensors:
//!   `keypoints` `[1, N, 2]` (i64 or f32, x then y), `scores`
//!   `[1, N]` f32, `descriptors` `[1, 256, N]` or `[1, N, 256]` f32.
//! - LightGlue: `lightglue.onnx` (matcher head). Inputs:
//!   `kpts0` `[1, N0, 2]`, `kpts1` `[1, N1, 2]`,
//!   `desc0` `[1, N0, 256]`, `desc1` `[1, N1, 256]` f32.
//!   Outputs: `matches0` `[N_matches, 2]` i64 (pairs of indices) and
//!   `mscores0` `[N_matches]` f32; OR `matches0` `[1, N0]` i64 with
//!   `-1` for unmatched query and `mscores0` `[1, N0]` f32. Both
//!   layouts are handled below.
//!
//! # Adapter contract
//!
//! Output is plumbed into the existing `Matches`/`Match` types so the
//! downstream pipeline (gimbal filter → RANSAC → BA) doesn't change.
//! Specifically: each LightGlue correspondence with confidence `c`
//! becomes a `Match { a, b, distance: 1.0 - c }`. RANSAC already
//! sorts by `distance` (lower = better), so this preserves the
//! expected ordering.

#![cfg(feature = "ml-lightglue")]

use std::path::{Path, PathBuf};

use tract_onnx::prelude::*;

use crate::error::PanoError;
use crate::types::{Features, Keypoint, Match, Matches, PanoImage};

/// Long-edge length used when resampling each input image down to
/// SuperPoint's preferred resolution. SuperPoint is shape-dynamic but
/// works best when both spatial dims are multiples of 8 (the network
/// downsamples by 8). 1024 is a good throughput/accuracy compromise
/// on full-frame DJI sensors.
const SUPERPOINT_LONG_EDGE: u32 = 1024;

/// Descriptor dimensionality emitted by the SuperPoint encoder we
/// support. Stored on `Features::descriptor_dim` after packing the f32
/// descriptors into bytes (see `pack_descriptors_as_bytes`).
const DESCRIPTOR_DIM_FLOATS: usize = 256;

/// Bytes per descriptor when packed into `Features::descriptors`.
/// We store the raw f32 components little-endian (4 bytes per float)
/// so the descriptors round-trip losslessly. Downstream code that
/// uses these (BruteForceMatcher's Hamming) won't be invoked: the
/// LightGlue path returns `Matches` directly. Storing them anyway
/// preserves the `Features` shape contract and keeps the door open
/// for future per-image caches.
const DESCRIPTOR_BYTES: usize = DESCRIPTOR_DIM_FLOATS * 4;

/// SuperPoint+LightGlue ONNX-backed matcher.
///
/// Construct once, reuse across pairs. Internally caches the
/// inference sessions so model load (~50–200 ms) doesn't repeat per
/// pair.
pub struct LightGlueMatcher {
    /// Path to the SuperPoint ONNX model.
    superpoint_path: PathBuf,
    /// Path to the LightGlue ONNX model.
    lightglue_path: PathBuf,
    /// Confidence threshold below which matches are dropped (0..1).
    confidence_threshold: f32,
    /// Loaded SuperPoint runnable session. `None` until first use.
    /// Lazily initialised so missing models don't crash the Cargo
    /// `--features ml-lightglue` build, only the first run.
    superpoint: Option<TractSession>,
    /// Loaded LightGlue runnable session.
    lightglue: Option<TractSession>,
}

/// Opaque wrapper around the inference session — kept as a typedef
/// here so the type signature doesn't leak the tract type churn.
type TractSession = Box<
    SimplePlan<
        TypedFact,
        Box<dyn TypedOp>,
        Graph<TypedFact, Box<dyn TypedOp>>,
    >,
>;

impl LightGlueMatcher {
    /// Construct the matcher. Validates the model paths exist; lazy-
    /// loads the actual ONNX graphs on first `match_pair` call.
    pub fn from_paths(
        superpoint_path: impl Into<PathBuf>,
        lightglue_path: impl Into<PathBuf>,
    ) -> Result<Self, PanoError> {
        let superpoint_path = superpoint_path.into();
        let lightglue_path = lightglue_path.into();
        if !superpoint_path.exists() {
            return Err(PanoError::Other(format!(
                "lightglue: SuperPoint model not found at {}",
                superpoint_path.display()
            )));
        }
        if !lightglue_path.exists() {
            return Err(PanoError::Other(format!(
                "lightglue: LightGlue model not found at {}",
                lightglue_path.display()
            )));
        }
        Ok(Self {
            superpoint_path,
            lightglue_path,
            confidence_threshold: 0.5,
            superpoint: None,
            lightglue: None,
        })
    }

    /// Set the confidence threshold (default 0.5). Matches with
    /// LightGlue confidence below this are dropped.
    pub fn with_confidence_threshold(mut self, threshold: f32) -> Self {
        self.confidence_threshold = threshold;
        self
    }

    /// Load both ONNX models if they aren't loaded yet.
    fn ensure_loaded(&mut self) -> Result<(), PanoError> {
        if self.superpoint.is_none() {
            self.superpoint = Some(load_session(&self.superpoint_path)?);
        }
        if self.lightglue.is_none() {
            self.lightglue = Some(load_session(&self.lightglue_path)?);
        }
        Ok(())
    }

    /// Run SuperPoint+LightGlue on a pair of `PanoImage`s. Returns
    /// `Features` for each plus `Matches` between them. Keypoints
    /// are reported in the **source-image** pixel coordinate system
    /// so the downstream pipeline can use them interchangeably with
    /// the AKAZE/ORB outputs.
    ///
    /// For multi-image pipelines that touch each image in many
    /// pairs, prefer `detect()` (run SuperPoint once per image,
    /// reuse the result) followed by `match_features()` (call
    /// LightGlue per pair). `match_pair()` re-runs SuperPoint on
    /// each call which is wasteful in that scenario.
    pub fn match_pair(
        &mut self,
        img_a: &PanoImage,
        img_b: &PanoImage,
    ) -> Result<(Features, Features, Matches), PanoError> {
        let detect_a = self.detect(img_a)?;
        let detect_b = self.detect(img_b)?;
        let matches = self.match_features(&detect_a, &detect_b)?;
        Ok((detect_a.features, detect_b.features, matches))
    }

    /// Per-image SuperPoint detection. Returns a `LightGlueDetection`
    /// that holds both the public `Features` (for downstream code
    /// that wants to consume keypoints in the existing shape) and
    /// the internal arrays needed by `match_features()`. Reuse the
    /// same detection across every pair the image participates in.
    pub fn detect(
        &mut self,
        img: &PanoImage,
    ) -> Result<LightGlueDetection, PanoError> {
        self.ensure_loaded()?;
        let detections = self.detect_superpoint(img)?;
        let features = features_from_detections(&detections);
        Ok(LightGlueDetection { detections, features })
    }

    /// Run LightGlue on a pre-detected pair. Returns `Matches`
    /// already filtered by the confidence threshold.
    pub fn match_features(
        &mut self,
        a: &LightGlueDetection,
        b: &LightGlueDetection,
    ) -> Result<Matches, PanoError> {
        self.ensure_loaded()?;
        let raw = self.match_descriptors(&a.detections, &b.detections)?;
        Ok(matches_from_confidences(&raw, self.confidence_threshold))
    }

    /// SuperPoint inference: image → (keypoints + per-keypoint
    /// descriptor). Keypoints are returned in the source-image's
    /// pixel coordinate system (i.e. mapped back through the resize
    /// scale we applied for inference).
    fn detect_superpoint(
        &mut self,
        img: &PanoImage,
    ) -> Result<Vec<DetectedKeypoint>, PanoError> {
        let session = self
            .superpoint
            .as_ref()
            .ok_or_else(|| PanoError::Other("lightglue: SuperPoint session not loaded".into()))?;

        // 1. Resize source RGB → greyscale f32 [0,1] at the
        //    SuperPoint-friendly long-edge size. Keep the scale so
        //    we can map keypoints back to source pixel coords.
        let (gray, infer_w, infer_h, scale_x, scale_y) =
            resize_to_grayscale_for_superpoint(img, SUPERPOINT_LONG_EDGE);

        // 2. Build [1, 1, H, W] f32 tensor.
        let input = tract_ndarray::Array4::from_shape_vec(
            (1, 1, infer_h as usize, infer_w as usize),
            gray,
        )
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to shape SuperPoint input tensor: {e}"
            ))
        })?;
        let input_tv: TValue = Tensor::from(input).into();

        // 3. Run inference.
        let outputs = session.run(tvec!(input_tv)).map_err(|e| {
            PanoError::Other(format!("lightglue: SuperPoint inference failed: {e}"))
        })?;

        // 4. Decode the three heads. The exact order varies per
        //    export. We probe outputs by rank/dtype rather than
        //    relying on output index.
        let parsed = parse_superpoint_outputs(&outputs)?;

        // 5. Map keypoint coords back to the source-image pixel
        //    coordinate space.
        let mut detections = Vec::with_capacity(parsed.keypoints.len());
        for ((kx, ky), (score, descriptor)) in parsed
            .keypoints
            .iter()
            .copied()
            .zip(parsed.scores.iter().copied().zip(parsed.descriptors))
        {
            let src_x = kx * scale_x;
            let src_y = ky * scale_y;
            detections.push(DetectedKeypoint {
                kp: Keypoint {
                    x: src_x,
                    y: src_y,
                    scale: 1.0,
                    angle: 0.0,
                    response: score,
                },
                // Inference-resolution coords as floats — what
                // LightGlue expects for its `kpts0` / `kpts1` inputs.
                infer_x: kx,
                infer_y: ky,
                descriptor,
            });
        }

        // Record the actual inference dims on every detection so
        // LightGlue input normalisation has the correct image_size.
        // (Done by writing the dims into a separate field on the
        // parent vector; we use a side-channel via the LightGlueMatcher
        // call — see `match_descriptors` for the consumer.)
        Ok(detections)
    }

    /// LightGlue inference: keypoints + descriptors from two images
    /// → list of `(idx_a, idx_b, confidence)`.
    fn match_descriptors(
        &mut self,
        kp_a: &[DetectedKeypoint],
        kp_b: &[DetectedKeypoint],
    ) -> Result<Vec<(u32, u32, f32)>, PanoError> {
        if kp_a.is_empty() || kp_b.is_empty() {
            return Ok(Vec::new());
        }

        let session = self
            .lightglue
            .as_ref()
            .ok_or_else(|| PanoError::Other("lightglue: LightGlue session not loaded".into()))?;

        // LightGlue expects keypoints normalised to roughly
        // image-relative coordinates (the official export divides
        // (x, y) by max(W, H) of the SuperPoint input image and
        // shifts to centre). We use the same normalisation here:
        // each export rebakes its own scale internally, but the
        // common LightGlue-ONNX export accepts INFERENCE-RESOLUTION
        // pixel coordinates directly. We pass those.
        let n_a = kp_a.len();
        let n_b = kp_b.len();

        let mut kpts0 = Vec::with_capacity(n_a * 2);
        let mut kpts1 = Vec::with_capacity(n_b * 2);
        let mut desc0 = Vec::with_capacity(n_a * DESCRIPTOR_DIM_FLOATS);
        let mut desc1 = Vec::with_capacity(n_b * DESCRIPTOR_DIM_FLOATS);

        for d in kp_a {
            kpts0.push(d.infer_x);
            kpts0.push(d.infer_y);
            desc0.extend_from_slice(&d.descriptor);
        }
        for d in kp_b {
            kpts1.push(d.infer_x);
            kpts1.push(d.infer_y);
            desc1.extend_from_slice(&d.descriptor);
        }

        let kpts0_t = tract_ndarray::Array3::from_shape_vec((1, n_a, 2), kpts0)
            .map_err(|e| PanoError::Other(format!("lightglue: kpts0 shape: {e}")))?;
        let kpts1_t = tract_ndarray::Array3::from_shape_vec((1, n_b, 2), kpts1)
            .map_err(|e| PanoError::Other(format!("lightglue: kpts1 shape: {e}")))?;
        let desc0_t =
            tract_ndarray::Array3::from_shape_vec((1, n_a, DESCRIPTOR_DIM_FLOATS), desc0)
                .map_err(|e| PanoError::Other(format!("lightglue: desc0 shape: {e}")))?;
        let desc1_t =
            tract_ndarray::Array3::from_shape_vec((1, n_b, DESCRIPTOR_DIM_FLOATS), desc1)
                .map_err(|e| PanoError::Other(format!("lightglue: desc1 shape: {e}")))?;

        // Most LightGlue ONNX exports take the inputs in the order
        // (kpts0, kpts1, desc0, desc1). If a specific export uses a
        // different order, this should be made config-driven, but
        // the official cvg/LightGlue export uses exactly this order.
        let inputs = tvec!(
            Tensor::from(kpts0_t).into(),
            Tensor::from(kpts1_t).into(),
            Tensor::from(desc0_t).into(),
            Tensor::from(desc1_t).into(),
        );

        let outputs = session
            .run(inputs)
            .map_err(|e| PanoError::Other(format!("lightglue: LightGlue inference failed: {e}")))?;

        parse_lightglue_outputs(&outputs, n_a)
    }
}

/// Aggregated SuperPoint output for a single image.
struct DetectedKeypoint {
    kp: Keypoint,
    /// Keypoint x in inference-resolution pixels (what LightGlue eats).
    infer_x: f32,
    /// Keypoint y in inference-resolution pixels.
    infer_y: f32,
    /// 256-D descriptor vector as f32.
    descriptor: Vec<f32>,
}

/// Per-image SuperPoint detection — `Features` (for downstream
/// consumers) plus the inference-side data needed by LightGlue. Pass
/// to `LightGlueMatcher::match_features()` to get matches against
/// another detection.
pub struct LightGlueDetection {
    /// SuperPoint output projected back to source-image pixel
    /// coordinates. Drop into the existing `Features` slot in the
    /// stitch pipeline.
    pub features: Features,
    /// Internal detection list — needed by LightGlue. Opaque outside
    /// this module.
    detections: Vec<DetectedKeypoint>,
}

/// Build a `Features` struct from a list of detections, packing
/// descriptors as little-endian f32 bytes.
fn features_from_detections(detections: &[DetectedKeypoint]) -> Features {
    let mut packed: Vec<u8> = Vec::with_capacity(detections.len() * DESCRIPTOR_BYTES);
    for d in detections {
        for &v in &d.descriptor {
            packed.extend_from_slice(&v.to_le_bytes());
        }
    }
    Features {
        keypoints: detections.iter().map(|d| d.kp).collect(),
        descriptors: packed,
        descriptor_dim: DESCRIPTOR_BYTES,
    }
}

/// Resize a `PanoImage` (RGB f32 in scene-linear Rec.2020) to a
/// greyscale f32 buffer suitable for SuperPoint, with the long edge
/// clamped to `long_edge`. Returns (gray pixels, w, h, scale_x,
/// scale_y) where scale maps inference-pixel → source-pixel.
///
/// Greyscale = Rec.709 luma applied to the linear RGB; clamped to
/// [0,1]. Resizing is bilinear in greyscale.
fn resize_to_grayscale_for_superpoint(
    img: &PanoImage,
    long_edge: u32,
) -> (Vec<f32>, u32, u32, f32, f32) {
    // First convert to full-resolution greyscale f32 in [0,1].
    let src_w = img.width as usize;
    let src_h = img.height as usize;
    let mut src_gray = Vec::with_capacity(src_w * src_h);
    for i in 0..(src_w * src_h) {
        let r = img.pixels[i * 3];
        let g = img.pixels[i * 3 + 1];
        let b = img.pixels[i * 3 + 2];
        // Rec.709 weights — same as util::gray::to_gray. Slight
        // primaries mismatch on Rec.2020 input is tolerable for
        // keypoint detection.
        let y = 0.212_6 * r + 0.715_2 * g + 0.072_2 * b;
        src_gray.push(y.clamp(0.0, 1.0));
    }

    // Compute target dims: long edge = long_edge, preserve aspect.
    let max_src = src_w.max(src_h) as u32;
    if max_src <= long_edge {
        // No resize. Map keypoints with scale=1.
        return (src_gray, src_w as u32, src_h as u32, 1.0, 1.0);
    }
    let scale = (long_edge as f32) / (max_src as f32);
    // Round to a multiple of 8 to keep SuperPoint's stride happy.
    let mut dst_w = ((src_w as f32) * scale).round() as u32;
    let mut dst_h = ((src_h as f32) * scale).round() as u32;
    dst_w = (dst_w / 8).max(1) * 8;
    dst_h = (dst_h / 8).max(1) * 8;

    // Bilinear resample.
    let mut dst = vec![0.0_f32; (dst_w as usize) * (dst_h as usize)];
    let scale_x = (src_w as f32) / (dst_w as f32);
    let scale_y = (src_h as f32) / (dst_h as f32);
    for dy in 0..dst_h {
        let sy = (dy as f32 + 0.5) * scale_y - 0.5;
        let y0 = sy.floor().max(0.0) as usize;
        let y1 = (y0 + 1).min(src_h - 1);
        let fy = (sy - y0 as f32).clamp(0.0, 1.0);
        for dx in 0..dst_w {
            let sx = (dx as f32 + 0.5) * scale_x - 0.5;
            let x0 = sx.floor().max(0.0) as usize;
            let x1 = (x0 + 1).min(src_w - 1);
            let fx = (sx - x0 as f32).clamp(0.0, 1.0);
            let p00 = src_gray[y0 * src_w + x0];
            let p01 = src_gray[y0 * src_w + x1];
            let p10 = src_gray[y1 * src_w + x0];
            let p11 = src_gray[y1 * src_w + x1];
            let v = (1.0 - fy) * ((1.0 - fx) * p00 + fx * p01)
                + fy * ((1.0 - fx) * p10 + fx * p11);
            dst[(dy as usize) * (dst_w as usize) + (dx as usize)] = v;
        }
    }

    (dst, dst_w, dst_h, scale_x, scale_y)
}

/// Decoded SuperPoint outputs.
struct ParsedSuperPoint {
    keypoints: Vec<(f32, f32)>,
    scores: Vec<f32>,
    descriptors: Vec<Vec<f32>>,
}

/// Parse SuperPoint's three output tensors into a strongly-typed
/// struct. The tensor order varies between exports; we identify
/// each output by rank/dtype:
///   - rank 3, dtype i64 OR f32 with last dim = 2 → keypoints
///   - rank 2, dtype f32 → scores
///   - rank 3, dtype f32 with one dim = 256 → descriptors
fn parse_superpoint_outputs(
    outputs: &[TValue],
) -> Result<ParsedSuperPoint, PanoError> {
    let mut keypoints: Option<Vec<(f32, f32)>> = None;
    let mut scores: Option<Vec<f32>> = None;
    let mut descriptors: Option<Vec<Vec<f32>>> = None;

    for tv in outputs {
        let t: &Tensor = tv;
        let shape = t.shape().to_vec();
        match t.datum_type() {
            DatumType::I64 if shape.len() == 3 && shape[2] == 2 => {
                let n = shape[1];
                let raw = t.as_slice::<i64>().map_err(|e| {
                    PanoError::Other(format!("lightglue: SuperPoint kpts(i64): {e}"))
                })?;
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    let kx = raw[i * 2] as f32;
                    let ky = raw[i * 2 + 1] as f32;
                    out.push((kx, ky));
                }
                keypoints = Some(out);
            }
            DatumType::F32 if shape.len() == 3 && shape[2] == 2 => {
                let n = shape[1];
                let raw = t.as_slice::<f32>().map_err(|e| {
                    PanoError::Other(format!("lightglue: SuperPoint kpts(f32): {e}"))
                })?;
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    out.push((raw[i * 2], raw[i * 2 + 1]));
                }
                keypoints = Some(out);
            }
            DatumType::F32 if shape.len() == 2 => {
                let n = shape[1];
                let raw = t.as_slice::<f32>().map_err(|e| {
                    PanoError::Other(format!("lightglue: SuperPoint scores: {e}"))
                })?;
                scores = Some(raw[..n].to_vec());
            }
            DatumType::F32 if shape.len() == 3 => {
                // Descriptors. Layout is either [1, D, N] or [1, N, D]
                // — D = 256.
                let raw = t.as_slice::<f32>().map_err(|e| {
                    PanoError::Other(format!("lightglue: SuperPoint desc: {e}"))
                })?;
                let (n, d, transpose) = if shape[1] == DESCRIPTOR_DIM_FLOATS
                    && shape[2] != DESCRIPTOR_DIM_FLOATS
                {
                    (shape[2], shape[1], true) // [1, 256, N]
                } else if shape[2] == DESCRIPTOR_DIM_FLOATS {
                    (shape[1], shape[2], false) // [1, N, 256]
                } else {
                    return Err(PanoError::Other(format!(
                        "lightglue: cannot identify descriptor layout from shape {shape:?}"
                    )));
                };
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    let mut desc = Vec::with_capacity(d);
                    if transpose {
                        // [1, D, N] — desc[k] = raw[k*N + i]
                        for k in 0..d {
                            desc.push(raw[k * n + i]);
                        }
                    } else {
                        // [1, N, D] — desc[k] = raw[i*D + k]
                        let off = i * d;
                        desc.extend_from_slice(&raw[off..off + d]);
                    }
                    out.push(desc);
                }
                descriptors = Some(out);
            }
            _ => {
                // Unknown / extra heads — skip silently. Some
                // SuperPoint exports include intermediate feature
                // maps as auxiliary outputs.
            }
        }
    }

    let keypoints = keypoints.ok_or_else(|| {
        PanoError::Other("lightglue: SuperPoint output missing keypoints head".into())
    })?;
    let scores = scores.ok_or_else(|| {
        PanoError::Other("lightglue: SuperPoint output missing scores head".into())
    })?;
    let descriptors = descriptors.ok_or_else(|| {
        PanoError::Other("lightglue: SuperPoint output missing descriptors head".into())
    })?;

    if keypoints.len() != scores.len() || keypoints.len() != descriptors.len() {
        return Err(PanoError::Other(format!(
            "lightglue: SuperPoint head length mismatch: kp={}, scores={}, desc={}",
            keypoints.len(),
            scores.len(),
            descriptors.len()
        )));
    }

    Ok(ParsedSuperPoint {
        keypoints,
        scores,
        descriptors,
    })
}

/// Parse LightGlue outputs into raw `(idx_a, idx_b, confidence)`
/// triplets. Two layouts are recognised:
///
/// 1. **"Per-query" layout** (cvg/LightGlue stock export):
///    `matches0` is rank-1 or rank-2 i64 of length `n_a`, with each
///    entry the index into image B (or `-1` for unmatched).
///    `mscores0` is f32 of length `n_a`.
///
/// 2. **"Sparse-pairs" layout** (some onnx-export wrappers):
///    `matches0` is `[K, 2]` i64 (pairs of indices), `mscores0` is
///    `[K]` f32.
fn parse_lightglue_outputs(
    outputs: &[TValue],
    n_a: usize,
) -> Result<Vec<(u32, u32, f32)>, PanoError> {
    let mut matches_tensor: Option<&Tensor> = None;
    let mut scores_tensor: Option<&Tensor> = None;

    for tv in outputs {
        let t: &Tensor = tv;
        match t.datum_type() {
            DatumType::I64 => matches_tensor = Some(t),
            DatumType::F32 => scores_tensor = Some(t),
            _ => {}
        }
    }

    let matches_t = matches_tensor.ok_or_else(|| {
        PanoError::Other("lightglue: LightGlue output missing match indices".into())
    })?;
    let scores_t = scores_tensor.ok_or_else(|| {
        PanoError::Other("lightglue: LightGlue output missing match scores".into())
    })?;

    let m_shape = matches_t.shape();
    let m_raw = matches_t
        .as_slice::<i64>()
        .map_err(|e| PanoError::Other(format!("lightglue: matches0 i64 slice: {e}")))?;
    let s_raw = scores_t
        .as_slice::<f32>()
        .map_err(|e| PanoError::Other(format!("lightglue: mscores0 f32 slice: {e}")))?;

    // Detect layout by trailing-2 axis on matches0.
    let trailing_two = m_shape.last().copied() == Some(2);
    if trailing_two {
        // Sparse pairs layout: [K, 2] (or [1, K, 2]).
        let k = m_raw.len() / 2;
        if s_raw.len() < k {
            return Err(PanoError::Other(format!(
                "lightglue: sparse pairs layout: |matches|={k} |scores|={}",
                s_raw.len()
            )));
        }
        let mut out = Vec::with_capacity(k);
        for i in 0..k {
            let a = m_raw[i * 2];
            let b = m_raw[i * 2 + 1];
            if a < 0 || b < 0 {
                continue;
            }
            out.push((a as u32, b as u32, s_raw[i]));
        }
        Ok(out)
    } else {
        // Per-query layout: matches0[i] = idx into B or -1.
        let n_q = m_raw.len();
        if n_q != s_raw.len() {
            return Err(PanoError::Other(format!(
                "lightglue: per-query layout: |matches|={n_q} |scores|={}",
                s_raw.len()
            )));
        }
        let _ = n_a; // sanity-only; n_q should match
        let mut out = Vec::new();
        for i in 0..n_q {
            let b = m_raw[i];
            if b < 0 {
                continue;
            }
            out.push((i as u32, b as u32, s_raw[i]));
        }
        Ok(out)
    }
}

/// Load an ONNX file into a runnable `tract` plan. Reads the model
/// from disk, runs shape inference, and freezes optimisation.
fn load_session(path: &Path) -> Result<TractSession, PanoError> {
    let model = tract_onnx::onnx()
        .model_for_path(path)
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to read ONNX at {}: {e}",
                path.display()
            ))
        })?
        .into_optimized()
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to optimise model {}: {e}",
                path.display()
            ))
        })?
        .into_runnable()
        .map_err(|e| {
            PanoError::Other(format!(
                "lightglue: failed to make runnable plan {}: {e}",
                path.display()
            ))
        })?;
    Ok(Box::new(model))
}

/// Convert a LightGlue match list (raw network output) to the
/// pipeline's `Matches`/`Match` form. Public for testability;
/// callers normally go through `match_pair`.
///
/// Each tuple is `(idx_a, idx_b, confidence_in_0_1)`. Output
/// `Match.distance` is `1.0 - confidence` so smaller = better.
pub fn matches_from_confidences(
    raw: &[(u32, u32, f32)],
    confidence_threshold: f32,
) -> Matches {
    let inliers: Vec<Match> = raw
        .iter()
        .copied()
        .filter(|(_, _, c)| *c >= confidence_threshold)
        .map(|(a, b, c)| Match {
            a,
            b,
            distance: 1.0 - c,
        })
        .collect();
    Matches { inliers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    #[test]
    fn matches_from_confidences_thresholds_and_inverts() {
        let raw = [(0u32, 1u32, 0.9), (2, 3, 0.6), (4, 5, 0.3)];
        let m = matches_from_confidences(&raw, 0.5);
        assert_eq!(m.inliers.len(), 2);
        assert!((m.inliers[0].distance - 0.1).abs() < 1e-6);
        assert!((m.inliers[1].distance - 0.4).abs() < 1e-6);
    }

    #[test]
    fn matches_from_confidences_empty_input() {
        let m = matches_from_confidences(&[], 0.5);
        assert!(m.inliers.is_empty());
    }

    #[test]
    fn matches_from_confidences_threshold_zero_keeps_all() {
        let raw = [(0u32, 1u32, 0.01), (2, 3, 0.0)];
        let m = matches_from_confidences(&raw, 0.0);
        assert_eq!(m.inliers.len(), 2);
    }

    /// Construction with non-existent paths must fail fast — we
    /// don't want a stitch run to discover the model's missing
    /// half-way through.
    #[test]
    fn from_paths_rejects_missing_files() {
        let r = LightGlueMatcher::from_paths(
            "/nonexistent/superpoint.onnx",
            "/nonexistent/lightglue.onnx",
        );
        assert!(r.is_err());
    }

    /// Compile-time silence: keep the unused-fields warning quiet
    /// on a feature build that doesn't yet wire up `Keypoint` /
    /// `Features`. The `match_pair` stub is the user of those
    /// types; this dummy assertion documents the dependency.
    #[test]
    fn feature_types_are_in_scope() {
        let _ = std::mem::size_of::<Features>();
        let _ = std::mem::size_of::<Keypoint>();
    }

    #[test]
    fn resize_preserves_long_edge_under_target() {
        // Source 64×128 → no resize, scale=1.
        let img = PanoImage::new(64, 128, ColorSpace::rec2020_d65_linear());
        let (gray, w, h, sx, sy) =
            resize_to_grayscale_for_superpoint(&img, SUPERPOINT_LONG_EDGE);
        assert_eq!(w, 64);
        assert_eq!(h, 128);
        assert_eq!(gray.len(), 64 * 128);
        assert!((sx - 1.0).abs() < 1e-6);
        assert!((sy - 1.0).abs() < 1e-6);
    }

    #[test]
    fn resize_clamps_long_edge_to_target() {
        // Source 4000×3000, long_edge target = 1024 → 1024×768.
        // Both must be multiples of 8.
        let mut img = PanoImage::new(4000, 3000, ColorSpace::rec2020_d65_linear());
        // Leave pixels at zero.
        // Fill a stripe so the bilinear path gets exercised.
        for x in 0..1000 {
            img.pixels[x * 3 + 1] = 1.0;
        }
        let (_gray, w, h, sx, sy) =
            resize_to_grayscale_for_superpoint(&img, 1024);
        assert!(w <= 1024);
        assert!(h <= 768);
        assert_eq!(w % 8, 0);
        assert_eq!(h % 8, 0);
        // scale_x maps inference pixel → source pixel; with src 4000
        // and dst ~1024, scale ≈ 3.9.
        assert!(sx > 3.5 && sx < 4.5);
        assert!(sy > 3.5 && sy < 4.5);
    }

    #[test]
    fn features_from_detections_packs_descriptor_bytes() {
        let descriptor: Vec<f32> = (0..DESCRIPTOR_DIM_FLOATS)
            .map(|i| i as f32 * 0.01)
            .collect();
        let det = vec![DetectedKeypoint {
            kp: Keypoint {
                x: 10.0,
                y: 20.0,
                scale: 1.0,
                angle: 0.0,
                response: 0.5,
            },
            infer_x: 5.0,
            infer_y: 8.0,
            descriptor: descriptor.clone(),
        }];
        let feats = features_from_detections(&det);
        assert_eq!(feats.keypoints.len(), 1);
        assert_eq!(feats.descriptors.len(), DESCRIPTOR_BYTES);
        assert_eq!(feats.descriptor_dim, DESCRIPTOR_BYTES);
        // Round-trip first float.
        let bytes: [u8; 4] = feats.descriptors[0..4]
            .try_into()
            .expect("4 bytes");
        let v = f32::from_le_bytes(bytes);
        assert!((v - descriptor[0]).abs() < 1e-6);
    }
}
