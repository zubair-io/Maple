//! ORB-style feature detector: oriented FAST keypoints + BRIEF descriptors.
//!
//! Implementation notes
//! --------------------
//! * Keypoints are detected via `imageproc::corners::oriented_fast`, which
//!   computes an intensity-centroid orientation for each corner.
//! * Descriptors use `imageproc::binary_descriptors::brief::brief` with
//!   256-bit BRIEF. The test pairs are derived from a fixed RNG seed (42) for
//!   reproducibility; the seed is exposed via `OrbDetector::new_with_seed`.
//! * Descriptors are packed as 32 bytes (256 bits) per keypoint in the
//!   `Features.descriptors` `Vec<u8>`.  `descriptor_dim = 32`.
//! * Border filtering ensures that no keypoint's BRIEF patch window extends
//!   beyond the image boundary.

use imageproc::binary_descriptors::brief::{brief, TestPair};
use imageproc::corners::{oriented_fast, OrientedFastCorner};
use imageproc::point::Point;
use rand::rngs::StdRng;
use rand::SeedableRng;
use rand_distr::{Distribution, Normal};

use crate::error::PanoError;
use crate::traits::FeatureDetector;
use crate::types::{Features, Keypoint, PanoImage};
use crate::util::gray::to_gray;

/// BRIEF patch radius — BRIEF uses a 31×31 pixel window.
const BRIEF_PATCH_RADIUS: u32 = 15;
/// BRIEF descriptor length in bits.
const DESCRIPTOR_BITS: usize = 256;
/// Packed byte count per descriptor (256 / 8).
const DESCRIPTOR_BYTES: usize = DESCRIPTOR_BITS / 8;

/// Classical ORB detector: oriented FAST corners + BRIEF descriptors.
///
/// ```
/// use pano_core::features::OrbDetector;
/// use pano_core::{FeatureDetector, ColorSpace, PanoImage};
/// let det = OrbDetector::default();
/// let img = PanoImage::new(64, 64, ColorSpace::rec2020_d65_linear());
/// let feats = det.detect(&img).unwrap();
/// let _ = feats.keypoints.len();
/// ```
pub struct OrbDetector {
    /// FAST threshold for corner acceptance (0–255; lower = more corners).
    pub fast_threshold: Option<u8>,
    /// Target number of keypoints returned by `oriented_fast`.
    pub target_keypoints: usize,
    /// Seed used to generate deterministic BRIEF test pairs.
    pub seed: u64,
}

impl Default for OrbDetector {
    fn default() -> Self {
        Self {
            fast_threshold: None, // auto-threshold
            target_keypoints: 500,
            seed: 42,
        }
    }
}

impl OrbDetector {
    pub fn new_with_seed(seed: u64) -> Self {
        Self {
            seed,
            ..Default::default()
        }
    }

    /// Build deterministic BRIEF test pairs from a fixed seed.
    fn build_test_pairs(&self) -> Vec<TestPair> {
        // Reproduce the same distribution imageproc uses internally (Gaussian,
        // sigma = 6.6, centred at BRIEF_PATCH_RADIUS + 1).
        let diameter = BRIEF_PATCH_RADIUS * 2 + 1;
        let centre = (BRIEF_PATCH_RADIUS + 1) as f32;
        let mut rng = StdRng::seed_from_u64(self.seed);
        let dist = Normal::new(centre, 6.6_f32).expect("valid normal dist");
        let mut pairs: Vec<TestPair> = Vec::with_capacity(DESCRIPTOR_BITS);
        while pairs.len() < DESCRIPTOR_BITS {
            let x0 = dist.sample(&mut rng) as u32;
            let y0 = dist.sample(&mut rng) as u32;
            let x1 = dist.sample(&mut rng) as u32;
            let y1 = dist.sample(&mut rng) as u32;
            if x0 < diameter && y0 < diameter && x1 < diameter && y1 < diameter {
                pairs.push(TestPair {
                    p0: Point::new(x0, y0),
                    p1: Point::new(x1, y1),
                });
            }
        }
        pairs
    }
}

impl FeatureDetector for OrbDetector {
    fn detect(&self, img: &PanoImage) -> Result<Features, PanoError> {
        let gray = to_gray(img);
        let (w, h) = (img.width, img.height);

        // Edge radius for oriented_fast must keep the patch inside the image.
        // BRIEF needs BRIEF_PATCH_RADIUS clearance on each side.
        let edge_radius = BRIEF_PATCH_RADIUS + 1;

        // Reject images that are smaller than two edge margins.
        if w < edge_radius * 2 + 1 || h < edge_radius * 2 + 1 {
            return Ok(Features {
                keypoints: Vec::new(),
                descriptors: Vec::new(),
                descriptor_dim: DESCRIPTOR_BYTES,
            });
        }

        let corners: Vec<OrientedFastCorner> = oriented_fast(
            &gray,
            self.fast_threshold,
            self.target_keypoints,
            edge_radius,
            Some(self.seed),
        );

        if corners.is_empty() {
            return Ok(Features {
                keypoints: Vec::new(),
                descriptors: Vec::new(),
                descriptor_dim: DESCRIPTOR_BYTES,
            });
        }

        // Filter: keep only keypoints whose BRIEF patch window stays in-bounds.
        let min_x = BRIEF_PATCH_RADIUS;
        let min_y = BRIEF_PATCH_RADIUS;
        let max_x = w.saturating_sub(BRIEF_PATCH_RADIUS + 1);
        let max_y = h.saturating_sub(BRIEF_PATCH_RADIUS + 1);

        let valid_corners: Vec<&OrientedFastCorner> = corners
            .iter()
            .filter(|c| {
                c.corner.x >= min_x
                    && c.corner.x <= max_x
                    && c.corner.y >= min_y
                    && c.corner.y <= max_y
            })
            .collect();

        let kp_points: Vec<Point<u32>> = valid_corners
            .iter()
            .map(|c| Point::new(c.corner.x, c.corner.y))
            .collect();

        // Build deterministic test pairs.
        let test_pairs = self.build_test_pairs();

        let (brief_descriptors, _) = brief(&gray, &kp_points, DESCRIPTOR_BITS, Some(&test_pairs))
            .map_err(|e| PanoError::Other(format!("BRIEF failed: {e}")))?;

        // Pack BriefDescriptor bits into Vec<u8> (32 bytes / 256-bit descriptor).
        let mut packed_descs: Vec<u8> =
            Vec::with_capacity(brief_descriptors.len() * DESCRIPTOR_BYTES);
        for bd in &brief_descriptors {
            // Each BriefDescriptor has 2 u128 values (for 256 bits).
            for word in &bd.bits {
                packed_descs.extend_from_slice(&word.to_le_bytes());
            }
        }

        // Build Keypoint list parallel to brief_descriptors.
        let keypoints: Vec<Keypoint> = valid_corners
            .iter()
            .take(brief_descriptors.len())
            .map(|c| Keypoint {
                x: c.corner.x as f32,
                y: c.corner.y as f32,
                scale: 1.0,
                angle: c.orientation,
                response: c.corner.score,
            })
            .collect();

        Ok(Features {
            keypoints,
            descriptors: packed_descs,
            descriptor_dim: DESCRIPTOR_BYTES,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    /// Simple LCG for deterministic noise without extra deps.
    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 33) as f32) / (u32::MAX as f32)
    }

    /// Textured image: Gaussian-like noise + bright "star" blobs.
    /// FAST reliably finds corners at star-edge transitions.
    fn textured_image(width: u32, height: u32, seed: u64) -> PanoImage {
        let mut img = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());
        let mut rng = seed;
        for pix in img.pixels.iter_mut() {
            let n = (lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng)) / 4.0;
            *pix = 0.2 + n * 0.2;
        }
        // Place 40 bright blobs of radius 3.
        let margin = 20u32;
        for _ in 0..40 {
            let cx = margin + (lcg(&mut rng) * (width - 2 * margin) as f32) as u32;
            let cy = margin + (lcg(&mut rng) * (height - 2 * margin) as f32) as u32;
            for dy in 0..=6u32 {
                for dx in 0..=6u32 {
                    let px = cx + dx;
                    let py = cy + dy;
                    if px < width && py < height {
                        let idx = (py * width + px) as usize;
                        img.pixels[idx * 3] = 1.0;
                        img.pixels[idx * 3 + 1] = 1.0;
                        img.pixels[idx * 3 + 2] = 1.0;
                    }
                }
            }
        }
        img
    }

    #[test]
    fn detect_returns_features_on_textured_image() {
        let img = textured_image(256, 256, 12345);
        let det = OrbDetector::default();
        let features = det.detect(&img).unwrap();
        assert!(
            !features.keypoints.is_empty(),
            "expected keypoints on textured image"
        );
        assert_eq!(
            features.descriptors.len(),
            features.keypoints.len() * DESCRIPTOR_BYTES
        );
        assert_eq!(features.descriptor_dim, DESCRIPTOR_BYTES);
    }

    #[test]
    fn detect_tiny_image_returns_empty() {
        let img = PanoImage::new(10, 10, ColorSpace::rec2020_d65_linear());
        let det = OrbDetector::default();
        let features = det.detect(&img).unwrap();
        assert!(features.keypoints.is_empty());
    }

    #[test]
    fn descriptors_are_packed_correctly() {
        let img = textured_image(256, 256, 99999);
        let det = OrbDetector::default();
        let features = det.detect(&img).unwrap();
        // Each keypoint must have exactly DESCRIPTOR_BYTES bytes.
        assert_eq!(
            features.descriptors.len(),
            features.keypoints.len() * DESCRIPTOR_BYTES
        );
    }
}
