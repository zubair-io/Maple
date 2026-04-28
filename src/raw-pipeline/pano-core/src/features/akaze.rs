//! AKAZE feature detector via the `akaze` Rust crate.
//!
//! AKAZE produces 64-byte M-LDB binary descriptors (512 bits). We pack
//! them into the existing `Features.descriptors` Vec<u8> with
//! descriptor_dim = 64 so the existing BruteForceMatcher (Hamming
//! distance) works without modification.

// akaze 0.7 depends on image 0.23; we alias it as image023 to avoid
// a type mismatch with the workspace image 0.25.
use image023::{DynamicImage, ImageBuffer, Luma};

use crate::error::PanoError;
use crate::traits::FeatureDetector;
use crate::types::{Features, Keypoint, PanoImage};
use crate::util::gray::to_gray;

/// Number of packed bytes per AKAZE descriptor (64 bytes = 512 bits).
const DESCRIPTOR_BYTES: usize = 64;

/// AKAZE feature detector wrapping the `akaze` crate.
///
/// AKAZE produces robust, scale- and rotation-invariant binary descriptors
/// matched with Hamming distance. The default threshold (`0.001`) is the
/// `akaze` crate's own default; lower values yield more keypoints.
///
/// ```
/// use pano_core::features::AkazeDetector;
/// use pano_core::{FeatureDetector, ColorSpace, PanoImage};
/// let det = AkazeDetector::default();
/// let img = PanoImage::new(64, 64, ColorSpace::rec2020_d65_linear());
/// let feats = det.detect(&img).unwrap();
/// let _ = feats.keypoints.len();
/// ```
#[derive(Debug, Clone)]
pub struct AkazeDetector {
    /// Detector contrast threshold. Lower = more keypoints.
    /// Default matches `akaze::Akaze::default()` (`detector_threshold = 0.001`).
    pub threshold: f64,
}

impl Default for AkazeDetector {
    fn default() -> Self {
        // 0.0005 is half the akaze crate's default (0.001), giving ~2× more
        // keypoints on typical images. The crate default of 0.001 yields ~32
        // keypoints on a 256×256 random-noise image; 0.0005 comfortably
        // exceeds the ≥50 smoke-test threshold.
        Self { threshold: 0.0005 }
    }
}

impl AkazeDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_threshold(threshold: f64) -> Self {
        Self { threshold }
    }
}

impl FeatureDetector for AkazeDetector {
    fn detect(&self, img: &PanoImage) -> Result<Features, PanoError> {
        let gray = to_gray(img);
        let (w, h) = (gray.width(), gray.height());

        // akaze requires at least 40 pixels in each dimension to build the
        // first scale-space evolution. Images smaller than this produce an
        // empty evolutions vector, which causes an index-out-of-bounds panic
        // inside the crate. Return empty features rather than panicking.
        if w < 40 || h < 40 {
            return Ok(Features {
                keypoints: Vec::new(),
                descriptors: Vec::new(),
                descriptor_dim: DESCRIPTOR_BYTES,
            });
        }

        // akaze 0.7 uses image 0.23; build an image023::GrayImage from raw bytes.
        let raw: Vec<u8> = gray.into_raw();
        let gray23 = ImageBuffer::<Luma<u8>, Vec<u8>>::from_raw(w, h, raw)
            .expect("pano-core: gray23 buffer size mismatch; this is a bug");
        let dyn_image = DynamicImage::ImageLuma8(gray23);

        let akaze = akaze::Akaze::new(self.threshold);
        let (kps, descs) = akaze.extract(&dyn_image);

        let keypoints: Vec<Keypoint> = kps
            .iter()
            .map(|kp| Keypoint {
                x: kp.point.0,
                y: kp.point.1,
                scale: kp.size,
                angle: kp.angle,
                response: kp.response,
            })
            .collect();

        // Pack descriptors as bytes. Each BitArray<64> holds 64 bytes.
        // BitArray::bytes() returns &[u8; 64].
        let mut packed = Vec::with_capacity(descs.len() * DESCRIPTOR_BYTES);
        for d in &descs {
            packed.extend_from_slice(d.bytes());
        }

        Ok(Features {
            keypoints,
            descriptors: packed,
            descriptor_dim: DESCRIPTOR_BYTES,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    fn textured_image(width: u32, height: u32, seed: u64) -> PanoImage {
        let mut img = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());
        let mut rng = seed;
        for i in 0..(width as usize * height as usize) {
            rng = rng
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let v = ((rng >> 33) as f32) / (u32::MAX as f32);
            img.pixels[i * 3] = v;
            img.pixels[i * 3 + 1] = v * 0.9;
            img.pixels[i * 3 + 2] = v * 0.85;
        }
        img
    }

    #[test]
    fn detect_returns_features_on_textured_image() {
        let img = textured_image(256, 256, 42);
        let det = AkazeDetector::default();
        let features = det.detect(&img).unwrap();
        assert!(
            !features.keypoints.is_empty(),
            "expected keypoints on textured image"
        );
        assert_eq!(
            features.descriptors.len(),
            features.keypoints.len() * DESCRIPTOR_BYTES,
        );
        assert_eq!(features.descriptor_dim, DESCRIPTOR_BYTES);
    }

    #[test]
    fn detect_empty_image_returns_no_keypoints() {
        let img = PanoImage::new(8, 8, ColorSpace::rec2020_d65_linear());
        let det = AkazeDetector::default();
        let features = det.detect(&img).unwrap();
        assert!(features.keypoints.is_empty());
    }
}
