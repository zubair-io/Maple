//! Surface-level tests for `pano-core` types and traits (T1.2).

use pano_core::{
    Blender, BundleAdjuster, Camera, ColorSpace, Distortion, FeatureDetector, FeatureMatcher,
    Features, Match, Matches, PanoError, PanoImage, ParallaxMode, PipelineOptions, Projection,
    SeamFinder, SeamMask, Transfer, WhitePoint,
};

#[test]
fn pano_image_construct() {
    let img = PanoImage::new(4, 3, ColorSpace::rec2020_d65_linear());
    assert_eq!(img.width, 4);
    assert_eq!(img.height, 3);
    // RGB interleaved f32, one element per channel per pixel.
    assert_eq!(img.pixels.len(), (4 * 3 * 3) as usize);
    // Validity defaults to all-valid.
    assert_eq!(img.validity.len(), (4 * 3) as usize);
    assert!(img.validity.iter().all(|b| *b));
}

#[test]
fn pano_image_invalidate_pixel() {
    let mut img = PanoImage::new(2, 2, ColorSpace::rec2020_d65_linear());
    img.set_invalid(1, 1);
    assert!(!img.is_valid(1, 1));
    assert!(img.is_valid(0, 0));
}

#[test]
fn color_space_working_is_rec2020_d65_linear() {
    let cs = ColorSpace::rec2020_d65_linear();
    assert!(matches!(cs.primaries, pano_core::Primaries::Bt2020));
    assert!(matches!(cs.white_point, WhitePoint::D65));
    assert!(matches!(cs.transfer, Transfer::Linear));
}

#[test]
fn color_space_prophoto_export_target() {
    let cs = ColorSpace::prophoto_d50_linear();
    assert!(matches!(cs.primaries, pano_core::Primaries::ProPhoto));
    assert!(matches!(cs.white_point, WhitePoint::D50));
    assert!(matches!(cs.transfer, Transfer::Linear));
}

#[test]
fn projection_variants() {
    let _ = Projection::Rectilinear;
    let _ = Projection::Cylindrical;
    let _ = Projection::Spherical;
}

#[test]
fn parallax_mode_variants() {
    let _ = ParallaxMode::Homography;
    let _ = ParallaxMode::TpsMesh;
}

#[test]
fn pipeline_options_defaults() {
    let opts = PipelineOptions::default();
    assert!(matches!(opts.projection, Projection::Cylindrical));
    assert!(matches!(opts.parallax_mode, ParallaxMode::Homography));
    assert_eq!(opts.max_dimension, 0); // 0 = unconstrained
                                       // Default output is the working color space.
    assert!(matches!(opts.output_color.transfer, Transfer::Linear));
}

#[test]
fn camera_construct() {
    let cam = Camera {
        focal: 1000.0,
        principal_point: None,
        rotation: nalgebra::Matrix3::identity(),
        translation: nalgebra::Vector3::zeros(),
        distortion: Distortion::default(),
    };
    assert!((cam.focal - 1000.0).abs() < 1e-6);
    assert_eq!(cam.distortion.k1, 0.0);
    assert_eq!(cam.distortion.k2, 0.0);
}

#[test]
fn pano_error_displays() {
    let e = PanoError::InsufficientMatches {
        found: 3,
        needed: 30,
    };
    let s = e.to_string();
    assert!(s.contains("3"));
    assert!(s.contains("30"));
}

// ---------------------------------------------------------------------------
// Trait-surface compile checks. Each trait gets a no-op stub impl on a unit
// struct to confirm the canonical signature exists and is object-safe.
// ---------------------------------------------------------------------------

struct StubDetector;
impl FeatureDetector for StubDetector {
    fn detect(&self, _img: &PanoImage) -> Result<Features, PanoError> {
        Ok(Features::default())
    }
}

struct StubMatcher;
impl FeatureMatcher for StubMatcher {
    fn match_pairs(&self, _a: &Features, _b: &Features) -> Result<Matches, PanoError> {
        Ok(Matches::default())
    }
}

struct StubBundler;
impl BundleAdjuster for StubBundler {
    fn solve(
        &self,
        n_images: usize,
        _pairs: &[(usize, usize, Matches)],
    ) -> Result<Vec<Camera>, PanoError> {
        Ok((0..n_images)
            .map(|_| Camera {
                focal: 1.0,
                principal_point: None,
                rotation: nalgebra::Matrix3::identity(),
                translation: nalgebra::Vector3::zeros(),
                distortion: Distortion::default(),
            })
            .collect())
    }
}

struct StubSeamFinder;
impl SeamFinder for StubSeamFinder {
    fn seams(&self, _images: &[&PanoImage]) -> Result<Vec<SeamMask>, PanoError> {
        Ok(Vec::new())
    }
}

struct StubBlender;
impl Blender for StubBlender {
    fn blend(&self, images: &[&PanoImage], _seams: &[SeamMask]) -> Result<PanoImage, PanoError> {
        Ok(images
            .first()
            .map(|i| PanoImage::new(i.width, i.height, i.color.clone()))
            .unwrap_or_else(|| PanoImage::new(1, 1, ColorSpace::prophoto_d50_linear())))
    }
}

#[test]
fn traits_are_object_safe() {
    let _: Box<dyn FeatureDetector> = Box::new(StubDetector);
    let _: Box<dyn FeatureMatcher> = Box::new(StubMatcher);
    let _: Box<dyn BundleAdjuster> = Box::new(StubBundler);
    let _: Box<dyn SeamFinder> = Box::new(StubSeamFinder);
    let _: Box<dyn Blender> = Box::new(StubBlender);
}

#[test]
fn matches_default_is_empty() {
    let m = Matches::default();
    assert_eq!(m.inliers.len(), 0);
    let _: &Match = &Match {
        a: 0,
        b: 0,
        distance: 0.0,
    };
}
