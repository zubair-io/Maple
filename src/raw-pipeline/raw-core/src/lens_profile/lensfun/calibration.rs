//! Bundled samples → raw-core `Calibration` parts on the shooting camera.
//!
//! The converter already rescaled every polynomial into the frame both
//! `liblensfun` and Adobe's LCP use: radius in units of the (real) focal
//! length. What remains at runtime is the [`Frame`], which needs the
//! camera's crop factor and the decoded active-area size: the focal length
//! in pixels is `real_focal_mm · crop · hypot(w, h) / hypot(36, 24)`,
//! because the sensor diagonal is `hypot(36, 24) / crop` millimetres and
//! `hypot(w, h)` pixels.

use super::bundle::{DistortionSample, RadialTerms, TcaSample, VignettingSample};
use crate::lens_profile::model::{Chromatic, Frame, Perspective, Vignette};

/// Full-frame diagonal, the crop-factor reference.
pub const FULL_FRAME_DIAGONAL_MM: f64 = 43.266_615_305_567_875;

pub fn frame(real_focal_mm: f64, camera_crop: f64, width: f64, height: f64) -> Frame {
    let focal_px = real_focal_mm * camera_crop * width.hypot(height) / FULL_FRAME_DIAGONAL_MM;
    let focal = focal_px / width.max(height);
    Frame {
        focal: [focal, focal],
        center: [0.5, 0.5],
    }
}

fn perspective(terms: RadialTerms, frame: Frame) -> Perspective {
    Perspective {
        frame,
        radial: terms.even,
        radial_odd: terms.odd,
        tangential: [0.0; 2],
        scale: terms.scale,
    }
}

pub fn distortion(
    sample: &DistortionSample,
    camera_crop: f64,
    width: f64,
    height: f64,
) -> Perspective {
    perspective(
        sample.terms,
        frame(sample.real_focal, camera_crop, width, height),
    )
}

pub fn chromatic(sample: &TcaSample, camera_crop: f64, width: f64, height: f64) -> Chromatic {
    let frame = frame(sample.real_focal, camera_crop, width, height);
    Chromatic {
        reference: frame,
        relative: [
            perspective(sample.red, frame),
            perspective(sample.blue, frame),
        ],
    }
}

/// Vignetting has no `real-focal` in Lensfun; its samples are keyed by the
/// nominal focal length, and the converter rescaled them with it.
pub fn vignette(sample: &VignettingSample, camera_crop: f64, width: f64, height: f64) -> Vignette {
    Vignette {
        frame: frame(sample.focal, camera_crop, width, height),
        radial: sample.k,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_focal_is_real_focal_in_pixels_over_the_long_edge() {
        // Full frame, 3:2, 9504 px wide: 24 mm is 24/36 of the width.
        let f = frame(24.0, 1.0, 9504.0, 6336.0);
        assert!((f.focal[0] - 24.0 / 36.0).abs() < 1e-6, "{}", f.focal[0]);
        // APS-C crop 1.5 halves the sensor width to 24 mm: 24 mm fills it.
        let aps = frame(24.0, 1.5, 6240.0, 4160.0);
        assert!((aps.focal[0] - 1.0).abs() < 1e-6, "{}", aps.focal[0]);
    }

    #[test]
    fn samples_become_calibration_parts_with_their_terms() {
        let terms = RadialTerms {
            scale: 0.98,
            even: [0.1, 0.0, 0.0],
            odd: [0.01, -0.02],
        };
        let d = distortion(
            &DistortionSample {
                focal: 24.0,
                real_focal: 23.5,
                terms,
            },
            1.0,
            6000.0,
            4000.0,
        );
        assert_eq!(d.radial, [0.1, 0.0, 0.0]);
        assert_eq!(d.radial_odd, [0.01, -0.02]);
        assert_eq!(d.scale, 0.98);
        assert_eq!(d.frame, frame(23.5, 1.0, 6000.0, 4000.0));
        let v = vignette(
            &VignettingSample {
                focal: 24.0,
                aperture: 5.6,
                distance: 5.0,
                k: [-0.3, 0.4, -0.5],
            },
            1.0,
            6000.0,
            4000.0,
        );
        assert!(v.gain(6000.0, 4000.0, [3000.0, 2000.0]).unwrap() == 1.0);
        let c = chromatic(
            &TcaSample {
                focal: 24.0,
                real_focal: 24.0,
                red: terms,
                blue: terms,
            },
            1.0,
            6000.0,
            4000.0,
        );
        assert_eq!(c.map(6000.0, 4000.0, [10.0, 10.0], 1), [10.0, 10.0]);
    }
}
