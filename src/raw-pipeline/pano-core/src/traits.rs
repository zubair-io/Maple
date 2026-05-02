//! Pipeline-stage traits. Each stage has a default classical
//! implementation and (optionally, behind feature flags) a neural one.

use crate::error::PanoError;
use crate::types::{Camera, Features, Matches, PanoImage, SeamMask};

/// Detect keypoints + descriptors in a single image.
///
/// ```
/// use pano_core::{FeatureDetector, Features, PanoError, PanoImage};
/// struct Noop;
/// impl FeatureDetector for Noop {
///     fn detect(&self, _img: &PanoImage) -> Result<Features, PanoError> {
///         Ok(Features::default())
///     }
/// }
/// let _: Box<dyn FeatureDetector> = Box::new(Noop);
/// ```
pub trait FeatureDetector: Send + Sync {
    fn detect(&self, img: &PanoImage) -> Result<Features, PanoError>;
}

/// Match descriptors across two images and return inliers.
///
/// ```
/// use pano_core::{FeatureMatcher, Features, Matches, PanoError};
/// struct Noop;
/// impl FeatureMatcher for Noop {
///     fn match_pairs(&self, _a: &Features, _b: &Features) -> Result<Matches, PanoError> {
///         Ok(Matches::default())
///     }
/// }
/// let _: Box<dyn FeatureMatcher> = Box::new(Noop);
/// ```
pub trait FeatureMatcher: Send + Sync {
    fn match_pairs(&self, a: &Features, b: &Features) -> Result<Matches, PanoError>;
}

/// Solve for per-image camera intrinsics + extrinsics from pairwise
/// matches.
///
/// ```
/// use pano_core::{BundleAdjuster, Camera, Distortion, Matches, PanoError};
/// struct Noop;
/// impl BundleAdjuster for Noop {
///     fn solve(
///         &self,
///         n: usize,
///         _pairs: &[(usize, usize, Matches)],
///     ) -> Result<Vec<Camera>, PanoError> {
///         Ok((0..n).map(|_| Camera {
///             focal: 1.0,
///             principal_point: None,
///             rotation: nalgebra::Matrix3::identity(),
///             translation: nalgebra::Vector3::zeros(),
///             distortion: Distortion::default(),
///         }).collect())
///     }
/// }
/// let _: Box<dyn BundleAdjuster> = Box::new(Noop);
/// ```
pub trait BundleAdjuster: Send + Sync {
    fn solve(
        &self,
        n_images: usize,
        pairs: &[(usize, usize, Matches)],
    ) -> Result<Vec<Camera>, PanoError>;
}

/// Find seams within the overlap region of warped images.
///
/// ```
/// use pano_core::{PanoError, PanoImage, SeamFinder, SeamMask};
/// struct Noop;
/// impl SeamFinder for Noop {
///     fn seams(&self, _images: &[&PanoImage]) -> Result<Vec<SeamMask>, PanoError> {
///         Ok(Vec::new())
///     }
/// }
/// let _: Box<dyn SeamFinder> = Box::new(Noop);
/// ```
pub trait SeamFinder: Send + Sync {
    fn seams(&self, images: &[&PanoImage]) -> Result<Vec<SeamMask>, PanoError>;
}

/// Blend warped + seamed images into a single output canvas.
///
/// ```
/// use pano_core::{Blender, ColorSpace, PanoError, PanoImage, SeamMask};
/// struct Noop;
/// impl Blender for Noop {
///     fn blend(
///         &self,
///         _images: &[&PanoImage],
///         _seams: &[SeamMask],
///     ) -> Result<PanoImage, PanoError> {
///         Ok(PanoImage::new(1, 1, ColorSpace::prophoto_d50_linear()))
///     }
/// }
/// let _: Box<dyn Blender> = Box::new(Noop);
/// ```
pub trait Blender: Send + Sync {
    fn blend(&self, images: &[&PanoImage], seams: &[SeamMask]) -> Result<PanoImage, PanoError>;
}

/// Warp an image into the output projection given its camera.
///
/// ```
/// use pano_core::{Camera, Distortion, PanoError, PanoImage, Projection, Warper};
/// struct Noop;
/// impl Warper for Noop {
///     fn warp(
///         &self,
///         img: &PanoImage,
///         _cam: &Camera,
///         _target: Projection,
///     ) -> Result<PanoImage, PanoError> {
///         Ok(img.clone())
///     }
/// }
/// let _: Box<dyn Warper> = Box::new(Noop);
/// ```
pub trait Warper: Send + Sync {
    fn warp(
        &self,
        img: &PanoImage,
        cam: &Camera,
        target: crate::types::Projection,
    ) -> Result<PanoImage, PanoError>;
}
