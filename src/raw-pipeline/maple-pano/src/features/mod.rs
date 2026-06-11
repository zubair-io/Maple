//! Keypoint detection — ALIKED via ONNX Runtime (`ml` feature, #1139).
//!
//! Spec §5.2 front end, milestone-staged: this module owns the
//! **detector** (image → keypoints + descriptors + scores); the paired
//! LightGlue matcher lives in [`crate::matching`]. The match-graph /
//! MAGSAC++ / solver side is ticket #1138's territory and is deliberately
//! absent here — the only contract between the two is the plain record
//! types ([`Keypoint`], [`FeatureSet`], [`crate::matching::MlMatch`]).
//!
//! # Pipeline shape
//!
//! ```text
//! LinearRgbFrame (scene-linear RGB f32, interleaved, [0,1])
//!   │  preprocess::letterbox_to_chw      — pure, unit-tested without ort
//!   ▼
//! [1, 3, S, S] f32 tensor (sRGB-encoded, letterboxed, zero-padded)
//!   │  ALIKED ONNX session (ort)
//!   ▼
//! keypoints [N,2] (normalized), descriptors [N,D], scores [N]
//!   │  postprocess::select_keypoints     — pure, unit-tested without ort
//!   ▼
//! FeatureSet (keypoints in source-image pixel coordinates)
//! ```
//!
//! # Color / grayscale convention
//!
//! ALIKED consumes **3-channel RGB** — there is no grayscale conversion in
//! this pipeline (unlike SuperPoint-family detectors, which take 1-channel
//! luma). What *does* happen is a transfer encode: the crate's images are
//! scene-linear ([`crate::source`] docs), while ALIKED was trained on
//! display-encoded photographs, so [`preprocess`] applies the sRGB OETF
//! before the resize. See [`preprocess`] for the derivation and tests.
//!
//! # Coordinates
//!
//! Keypoints are reported in the **source image's continuous pixel
//! coordinate system** — origin at the top-left corner, texel `(ix, iy)`
//! centered at `(ix + 0.5, iy + 0.5)` — the crate-wide binding convention
//! ([`crate::camera`]), so they feed `Camera::pixel_to_world_dir` and the
//! #1138 geometry stack without adjustment.

pub mod postprocess;
pub mod preprocess;

mod aliked;

pub use aliked::{AlikedDetector, DetectorOptions};
pub use postprocess::KeypointFilter;

use crate::models::MlError;

/// An owned scene-linear RGB image: row-major, interleaved `[r, g, b]`,
/// values nominally in `[0, 1]` linear light (the crate's image
/// convention — see [`crate::source`] for the linearity contract).
#[derive(Debug, Clone)]
pub struct LinearRgbFrame {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` interleaved samples.
    pub pixels: Vec<f32>,
}

impl LinearRgbFrame {
    /// Wrap an interleaved RGB f32 buffer, validating the length.
    pub fn new(width: u32, height: u32, pixels: Vec<f32>) -> Result<Self, MlError> {
        let expected = width as usize * height as usize * 3;
        if width == 0 || height == 0 {
            return Err(MlError::BadImage(format!(
                "frame dimensions must be non-zero (got {width}x{height})"
            )));
        }
        if pixels.len() != expected {
            return Err(MlError::BadImage(format!(
                "pixel buffer has {} samples, {width}x{height} RGB needs {expected}",
                pixels.len()
            )));
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    /// Convert a 16-bit interleaved RGB frame (the [`crate::render`]
    /// output format) to linear f32 — a pure `v / 65535` normalization,
    /// matching the renderer's "outputs are 16-bit linear PNGs" contract.
    pub fn from_u16_rgb(width: u32, height: u32, data: &[u16]) -> Result<Self, MlError> {
        let pixels = data.iter().map(|&v| v as f32 / 65535.0).collect();
        Self::new(width, height, pixels)
    }
}

/// One detected keypoint in source-image continuous pixel coordinates
/// (texel centers at half-integers — see the module docs).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Keypoint {
    pub x: f32,
    pub y: f32,
    /// Detector confidence in `[0, 1]` (ALIKED score-map value).
    pub score: f32,
}

/// Detection result for one image: keypoints in source pixel coordinates
/// plus their descriptors, ordered by descending score.
///
/// This is the detector half of the #1138 contract type set. The
/// `norm_keypoints` field is matcher-internal: LightGlue consumes the
/// detector's own normalized coordinate encoding, which only makes sense
/// alongside the letterbox geometry this crate used for inference — so it
/// is `pub(crate)` and the public surface stays pixel-space only.
#[derive(Debug, Clone)]
pub struct FeatureSet {
    /// Detected keypoints, descending score order.
    pub keypoints: Vec<Keypoint>,
    /// Row-major `keypoints.len() × descriptor_dim` descriptor matrix
    /// (L2-normalized by the network; stored as emitted).
    pub descriptors: Vec<f32>,
    /// Descriptor width (128 for the pinned ALIKED-N16rot export; read
    /// from the output tensor shape, never hard-coded).
    pub descriptor_dim: usize,
    /// Keypoints in the detector's normalized inference coordinates
    /// (`[-1, 1]` over the letterboxed square) — exactly what the paired
    /// LightGlue export takes as `kpts0`/`kpts1`. Parallel to `keypoints`.
    pub(crate) norm_keypoints: Vec<[f32; 2]>,
}

impl FeatureSet {
    /// Descriptor row for keypoint `i`.
    pub fn descriptor(&self, i: usize) -> &[f32] {
        &self.descriptors[i * self.descriptor_dim..(i + 1) * self.descriptor_dim]
    }

    /// Number of keypoints.
    pub fn len(&self) -> usize {
        self.keypoints.len()
    }

    /// `true` when no keypoints were detected.
    pub fn is_empty(&self) -> bool {
        self.keypoints.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_rgb_frame_validates_length() {
        assert!(LinearRgbFrame::new(2, 2, vec![0.0; 12]).is_ok());
        let err = LinearRgbFrame::new(2, 2, vec![0.0; 11]).expect_err("wrong len");
        assert!(matches!(err, MlError::BadImage(_)));
        let err = LinearRgbFrame::new(0, 2, vec![]).expect_err("zero dim");
        assert!(matches!(err, MlError::BadImage(_)));
    }

    #[test]
    fn from_u16_rgb_normalizes_full_scale_to_one() {
        let frame =
            LinearRgbFrame::from_u16_rgb(1, 2, &[0, 32768, 65535, 65535, 0, 16384]).expect("frame");
        assert_eq!(frame.pixels[0], 0.0);
        assert!((frame.pixels[2] - 1.0).abs() < 1e-7);
        assert!((frame.pixels[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn feature_set_descriptor_rows_slice_correctly() {
        let fs = FeatureSet {
            keypoints: vec![
                Keypoint {
                    x: 1.0,
                    y: 2.0,
                    score: 0.9,
                },
                Keypoint {
                    x: 3.0,
                    y: 4.0,
                    score: 0.8,
                },
            ],
            descriptors: vec![1.0, 0.0, 0.0, 1.0],
            descriptor_dim: 2,
            norm_keypoints: vec![[0.0, 0.0], [0.5, 0.5]],
        };
        assert_eq!(fs.len(), 2);
        assert!(!fs.is_empty());
        assert_eq!(fs.descriptor(0), &[1.0, 0.0]);
        assert_eq!(fs.descriptor(1), &[0.0, 1.0]);
    }
}
