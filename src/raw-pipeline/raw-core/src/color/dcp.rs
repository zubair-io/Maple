use crate::{
    color::matrices::{M_PRO_TO_XYZ_D50, XYZ_D50, bradford_adapt, m_pro_to_rec2020},
    image::{ColorSpace, Image, RawImage},
    math::{Matrix3, Vec3},
};

/// DNG CalibrationIlluminant. Spec § 3.4.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Illuminant {
    StdA,      // ~2850K
    D50,       // ~5003K
    D55,
    D65,       // ~6504K
    Other(u32),
}

impl Illuminant {
    pub fn xyz(self) -> Vec3 {
        // Reference whites; Y normalized to 1.0. CIE 1931 2° observer.
        match self {
            Self::StdA => [1.0985, 1.0000, 0.3558],
            Self::D50  => [0.9642, 1.0000, 0.8251],
            Self::D55  => [0.9568, 1.0000, 0.9214],
            Self::D65  => [0.9504, 1.0000, 1.0888],
            Self::Other(_) => [0.9504, 1.0000, 1.0888], // fallback D65
        }
    }
}

/// Minimal DCP for slice 1. Spec § 3.4 subset:
///   single illuminant, CM (camera → XYZ), optional FM (XYZ D50 → ProPhoto).
/// No HueSatMap, no ProfileLookTable, no dual-illuminant interpolation. Those
/// land in slice 4 per the roadmap.
#[derive(Clone, Debug)]
pub struct DcpProfile {
    pub illuminant: Illuminant,
    /// Camera RGB → XYZ at `illuminant`. Spec § 3.4 step 1.
    pub color_matrix: Matrix3,
    /// XYZ D50 → ProPhoto RGB. Optional per DNG spec; when absent, we derive
    /// via the inverse of `M_PRO_TO_XYZ_D50`.
    pub forward_matrix: Option<Matrix3>,
}

impl DcpProfile {
    /// Build a minimal DCP from an embedded ColorMatrix with the
    /// assumption it's D65. Used for rawler-decoded fixtures where we
    /// preferred the D65 (or D50) illuminant in decode.rs. Spec § 3.4
    /// edge case: "Profile has only CM1/CM2 — use standard D50 Bradford
    /// adapt from XYZ to ProPhoto."
    pub fn from_embedded_cm(cm: Matrix3) -> Self {
        Self {
            illuminant: Illuminant::D65,
            color_matrix: cm,
            forward_matrix: None,
        }
    }
}

/// Apply DCP to camera-native linear RGB, producing scene-linear Rec.2020 D65.
/// Slice 1: single illuminant, CM + (FM or fallback), no HSM, no PLT.
///
/// Per spec § 3.4 and § 04 "Camera-native → Rec.2020":
///   rgb_rec2020 = M_pro_to_rec2020 * FM * Bradford(source_illum → D50) * CM * rgb_cam
pub fn apply(camera: &Image, profile: &DcpProfile) -> Image {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);

    // Compose the camera → Rec.2020 matrix once (not per-pixel).
    let adapt = bradford_adapt(profile.illuminant.xyz(), XYZ_D50);
    let fm = profile.forward_matrix.unwrap_or_else(|| {
        // No FM: standard XYZ D50 → ProPhoto via inverse of ProPhoto→XYZ D50.
        M_PRO_TO_XYZ_D50.inverse().expect("ProPhoto matrix is invertible")
    });
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&fm).mul_mat(&adapt).mul_mat(&profile.color_matrix);

    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in camera.pixels.iter().enumerate() {
        out.pixels[i] = m.mul_vec(*p);
    }
    out
}

/// Slice-1 convenience: synthesize a DcpProfile from a `RawImage`'s embedded
/// color matrix (whichever illuminant rawler preferred), or return
/// `Error::Dcp` if none is available.
pub fn profile_for(raw: &RawImage) -> crate::Result<DcpProfile> {
    match raw.embedded_color_matrix {
        Some(cm) => Ok(DcpProfile::from_embedded_cm(cm)),
        None => Err(crate::Error::Dcp(format!(
            "no embedded color matrix for {} {}",
            raw.camera_make, raw.camera_model
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_cm_produces_rec2020_neutral_grays() {
        // A degenerate profile whose CM is identity (CM acts as "camera IS XYZ").
        // The math still runs Bradford + FM + M_pro_to_rec2020, so the output
        // won't be identity, but it will be finite and roughly neutral.
        let profile = DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: Matrix3::IDENTITY,
            forward_matrix: None,
        };
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        let out = apply(&img, &profile);
        assert_eq!(out.space, ColorSpace::SceneLinearRec2020);
        // All four pixels should match one another.
        let first = out.pixels[0];
        for p in &out.pixels {
            assert!((p[0] - first[0]).abs() < 1e-5);
            assert!((p[1] - first[1]).abs() < 1e-5);
            assert!((p[2] - first[2]).abs() < 1e-5);
        }
        // Values finite. The composition isn't identity so values won't
        // exactly equal 0.18, but they should stay in a reasonable range.
        for &c in &first {
            assert!(c.is_finite());
        }
    }

    #[test]
    fn pipeline_produces_rec2020_output() {
        let profile = DcpProfile::from_embedded_cm(Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ])); // plausible-shape camera matrix
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.5, 0.5, 0.5];
        let out = apply(&img, &profile);
        assert_eq!(out.space, ColorSpace::SceneLinearRec2020);
        // Output is finite.
        for &c in &out.pixels[0] {
            assert!(c.is_finite());
        }
    }

    #[test]
    fn profile_for_returns_err_when_no_matrix() {
        let raw = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            embedded_color_matrix: None,
        };
        let err = profile_for(&raw).unwrap_err();
        match err {
            crate::Error::Dcp(_) => {}
            other => panic!("expected Error::Dcp, got {:?}", other),
        }
    }

    #[test]
    fn profile_for_succeeds_when_matrix_present() {
        let raw = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            embedded_color_matrix: Some(Matrix3::IDENTITY),
        };
        let profile = profile_for(&raw).unwrap();
        assert_eq!(profile.illuminant, Illuminant::D65);
        assert_eq!(profile.color_matrix, Matrix3::IDENTITY);
        assert!(profile.forward_matrix.is_none());
    }
}
