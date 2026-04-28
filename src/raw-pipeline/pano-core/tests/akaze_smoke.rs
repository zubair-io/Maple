//! Smoke test: AKAZE detects ≥50 keypoints on a synthetic textured image.
//!
//! The implementation lands in Task 1.2; this test validates that
//! when `AkazeDetector` exists it produces a sane number of keypoints
//! on a known-textured input.

use pano_core::features::akaze::AkazeDetector;
use pano_core::traits::FeatureDetector;
use pano_core::{ColorSpace, PanoImage};

fn synthetic_textured_image(w: u32, h: u32, seed: u64) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    let mut rng = seed;
    for i in 0..(w as usize * h as usize) {
        rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let v = ((rng >> 33) as f32) / (u32::MAX as f32);
        img.pixels[i * 3] = v;
        img.pixels[i * 3 + 1] = v * 0.9;
        img.pixels[i * 3 + 2] = v * 0.85;
    }
    img
}

#[test]
fn akaze_detects_features_on_synthetic_image() {
    let img = synthetic_textured_image(256, 256, 42);
    let detector = AkazeDetector::default();
    let features = detector.detect(&img).expect("detection should succeed");
    assert!(
        features.keypoints.len() >= 50,
        "expected ≥50 keypoints, got {}",
        features.keypoints.len()
    );
    assert!(
        !features.descriptors.is_empty(),
        "expected non-empty descriptors"
    );
}
