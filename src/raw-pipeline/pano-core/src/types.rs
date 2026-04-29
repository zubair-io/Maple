//! Core data types for the panorama pipeline.

use bitvec::vec::BitVec;
use nalgebra::Matrix3;

use crate::color::ColorSpace;

/// Interleaved RGB float32 image in scene-linear color space.
///
/// Pixels are stored row-major as `[r, g, b, r, g, b, ...]`. Each pixel
/// also carries one validity bit — warping creates invalid regions.
#[derive(Debug, Clone)]
pub struct PanoImage {
    pub pixels: Vec<f32>,
    pub width: u32,
    pub height: u32,
    pub color: ColorSpace,
    pub validity: BitVec,
}

impl PanoImage {
    /// Construct an all-zero image with everything marked valid.
    pub fn new(width: u32, height: u32, color: ColorSpace) -> Self {
        let n = (width as usize) * (height as usize);
        Self {
            pixels: vec![0.0; n * 3],
            width,
            height,
            color,
            validity: BitVec::repeat(true, n),
        }
    }

    #[inline]
    fn index(&self, x: u32, y: u32) -> usize {
        debug_assert!(x < self.width && y < self.height);
        (y as usize) * (self.width as usize) + (x as usize)
    }

    pub fn is_valid(&self, x: u32, y: u32) -> bool {
        self.validity[self.index(x, y)]
    }

    pub fn set_invalid(&mut self, x: u32, y: u32) {
        let idx = self.index(x, y);
        self.validity.set(idx, false);
    }
}

/// Pinhole camera model used by bundle adjustment.
///
/// `translation` is in the planar-at-unit-depth scale used by
/// `ba::joint::solve_joint_with_priors` — i.e. world units where the
/// scene plane is at z = 1. Defaults to zero (pure rotation stitch).
/// When non-zero, the canvas warp applies the corresponding parallax
/// correction so BA-discovered translations actually affect the
/// stitched output.
#[derive(Debug, Clone)]
pub struct Camera {
    /// Focal length in pixels.
    pub focal: f32,
    /// Rotation matrix in the common world frame.
    pub rotation: Matrix3<f32>,
    /// Per-camera translation in world units (planar-at-unit-depth scale).
    pub translation: nalgebra::Vector3<f32>,
    /// Radial distortion coefficients.
    pub distortion: Distortion,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            focal: 1.0,
            rotation: Matrix3::identity(),
            translation: nalgebra::Vector3::zeros(),
            distortion: Distortion::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Distortion {
    pub k1: f32,
    pub k2: f32,
}

/// Output projection geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    Rectilinear,
    Cylindrical,
    Spherical,
}

/// Strategy for handling parallax in the warp stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParallaxMode {
    Homography,
    TpsMesh,
}

/// Top-level pipeline knobs.
#[derive(Debug, Clone)]
pub struct PipelineOptions {
    pub projection: Projection,
    pub output_color: ColorSpace,
    /// 0 = unconstrained.
    pub max_dimension: u32,
    pub parallax_mode: ParallaxMode,
}

impl Default for PipelineOptions {
    fn default() -> Self {
        Self {
            projection: Projection::Cylindrical,
            output_color: ColorSpace::rec2020_d65_linear(),
            max_dimension: 0,
            parallax_mode: ParallaxMode::Homography,
        }
    }
}

/// Detector output — keypoints + descriptors for one image.
#[derive(Debug, Default, Clone)]
pub struct Features {
    pub keypoints: Vec<Keypoint>,
    /// Packed descriptor bytes; row stride = `descriptor_dim`.
    pub descriptors: Vec<u8>,
    pub descriptor_dim: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct Keypoint {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub angle: f32,
    pub response: f32,
}

/// Matcher output — inlier correspondences between two `Features` sets.
#[derive(Debug, Default, Clone)]
pub struct Matches {
    pub inliers: Vec<Match>,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    /// Keypoint index in the "a" image.
    pub a: u32,
    /// Keypoint index in the "b" image.
    pub b: u32,
    /// Descriptor distance (lower is better).
    pub distance: f32,
}

/// One image's seam mask in the output canvas. `0` = use this image,
/// `1` = use the other.
#[derive(Debug, Default, Clone)]
pub struct SeamMask {
    pub width: u32,
    pub height: u32,
    pub bits: BitVec,
}
