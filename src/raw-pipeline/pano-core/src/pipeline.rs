//! Public stitching pipeline.
//!
//! Mirrors the classical pipeline used by the `raw-ffi` C ABI (`stitch_two`)
//! without unsafe code, so it can be called from wasm-bindgen (T5.5) and
//! future Rust callers directly.
//!
//! For the MVP (T5.5) only two-image stitching is supported.  N > 2 inputs
//! are a P4+ follow-up.

use crate::{
    ba::{homography::ransac_homography, lm::solve_with_keypoints},
    error::PanoError,
    types::{Camera, Distortion, Matches, PanoImage, PipelineOptions, Projection},
    BruteForceMatcher, GraphCutSeamFinder, MultiBandBlender, OrbDetector,
};
use crate::traits::{Blender, FeatureDetector, FeatureMatcher, SeamFinder, Warper};
use crate::warp::CpuWarper;

/// Stitch a slice of `PanoImage`s using the classical ORB→match→BA→warp→blend
/// pipeline.
///
/// The MVP implementation processes exactly the first two images.  Providing
/// more than two is accepted (extra images are ignored today; a future
/// pairwise-composition pass will consume them).
///
/// Returns the blended `PanoImage` in the same color space as the inputs.
pub fn stitch_images(images: &[PanoImage], options: &PipelineOptions) -> Result<PanoImage, PanoError> {
    if images.len() < 2 {
        return Err(PanoError::Other(
            "stitch_images requires at least 2 images".to_string(),
        ));
    }

    let img_a = &images[0];
    let img_b = &images[1];

    stitch_two(img_a, img_b, options)
}

fn stitch_two(img_a: &PanoImage, img_b: &PanoImage, _options: &PipelineOptions) -> Result<PanoImage, PanoError> {
    let image_size = (img_a.width.max(img_b.width), img_a.height.max(img_b.height));

    // Feature detection.
    let detector = OrbDetector::default();
    let feats_a = detector.detect(img_a)
        .map_err(|e| PanoError::Other(format!("detect A: {e}")))?;
    let feats_b = detector.detect(img_b)
        .map_err(|e| PanoError::Other(format!("detect B: {e}")))?;

    // Matching.
    let matcher = BruteForceMatcher::default();
    let matches = matcher.match_pairs(&feats_a, &feats_b)
        .map_err(|e| PanoError::Other(format!("match: {e}")))?;

    // Cameras — RANSAC + BA when enough matches, identity fallback otherwise.
    let cameras: Vec<Camera> = if matches.inliers.len() >= 8 {
        let (_, inlier_idxs) = ransac_homography(
            &feats_a.keypoints, &feats_b.keypoints, &matches.inliers, 3.0, 2000, 42,
        ).ok_or_else(|| PanoError::Other("RANSAC failed".to_string()))?;

        let ransac_matches = Matches {
            inliers: inlier_idxs.iter().map(|&i| matches.inliers[i]).collect(),
        };
        let pairs = vec![(
            0usize, 1usize,
            ransac_matches,
            feats_a.keypoints.clone(),
            feats_b.keypoints.clone(),
        )];
        solve_with_keypoints(2, &pairs, image_size, 42)
            .map_err(|e| PanoError::Other(format!("BA: {e}")))?
    } else {
        // Identity fallback — build the 3×3 identity matrix for both cameras.
        let focal = image_size.0.max(image_size.1) as f32;
        let identity = nalgebra::Matrix3::<f32>::identity();
        vec![
            Camera {
                focal,
                rotation: identity,
                translation: nalgebra::Vector3::zeros(),
                distortion: Distortion::default(),
            },
            Camera {
                focal,
                rotation: identity,
                translation: nalgebra::Vector3::zeros(),
                distortion: Distortion::default(),
            },
        ]
    };

    // Warp.
    let warper = CpuWarper::new();
    let warp = |img: &PanoImage, cam: &Camera| -> Result<PanoImage, PanoError> {
        let warped = warper.warp(img, cam, Projection::Rectilinear)
            .map_err(|e| PanoError::Other(format!("warp: {e}")))?;
        // Embed into a canvas matching the input size if the warped result
        // is smaller (identity warp preserves dimensions).
        if warped.width == image_size.0 && warped.height == image_size.1 {
            return Ok(warped);
        }
        let mut canvas = PanoImage::new(image_size.0, image_size.1, img.color);
        for i in 0..(image_size.0 as usize * image_size.1 as usize) {
            canvas.validity.set(i, false);
        }
        let cw = warped.width.min(image_size.0) as usize;
        let ch = warped.height.min(image_size.1) as usize;
        for y in 0..ch {
            for x in 0..cw {
                let si = y * warped.width as usize + x;
                let di = y * image_size.0 as usize + x;
                canvas.pixels[di * 3] = warped.pixels[si * 3];
                canvas.pixels[di * 3 + 1] = warped.pixels[si * 3 + 1];
                canvas.pixels[di * 3 + 2] = warped.pixels[si * 3 + 2];
                if warped.validity[si] {
                    canvas.validity.set(di, true);
                }
            }
        }
        Ok(canvas)
    };

    let warped_a = warp(img_a, &cameras[0])?;
    let warped_b = warp(img_b, &cameras[1])?;

    // Seam + blend.
    let seam_finder = GraphCutSeamFinder::new();
    let seams = seam_finder.seams(&[&warped_a, &warped_b])
        .map_err(|e| PanoError::Other(format!("seam: {e}")))?;

    let blender = MultiBandBlender::default();
    let result = blender.blend(&[&warped_a, &warped_b], &seams)
        .map_err(|e| PanoError::Other(format!("blend: {e}")))?;

    Ok(result)
}
