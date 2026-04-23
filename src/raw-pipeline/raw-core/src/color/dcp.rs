use crate::{
    color::{
        illuminant::Illuminant,
        matrices::{M_PRO_TO_XYZ_D50, XYZ_D50, bradford_adapt, m_pro_to_rec2020},
    },
    image::{ColorSpace, Image, RawImage},
    math::Matrix3,
};

// Re-export Illuminant so existing code that imported it from dcp keeps working.
pub use crate::color::illuminant::Illuminant as DcpIlluminant;

/// Minimal DCP for slice 1+. Spec § 3.4 subset:
///   single (or interpolated) illuminant, CM (camera → XYZ), optional FM (XYZ D50 → ProPhoto).
/// No HueSatMap, no ProfileLookTable. Those land in a later slice per the roadmap.
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
/// DNG's `ColorMatrix` is defined `XYZ → camera`; for decoding we use its
/// inverse. See DNG 1.6 § 1.4.4.1. The error variant propagates when the
/// matrix is singular (degenerate profile); callers should treat it as a
/// decode failure.
pub fn apply(camera: &Image, profile: &DcpProfile) -> crate::Result<Image> {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);

    let cam_to_xyz = profile.color_matrix.inverse().ok_or_else(|| {
        crate::Error::Dcp("ColorMatrix is singular, cannot invert to camera→XYZ".into())
    })?;

    // Compose the camera → Rec.2020 matrix once (not per-pixel).
    //   rgb_rec2020 = M_pro_to_rec2020 * FM * Bradford(illum→D50) * inv(CM) * rgb_cam
    let adapt = bradford_adapt(profile.illuminant.xyz(), XYZ_D50);
    let fm = profile.forward_matrix.unwrap_or_else(|| {
        // No FM: standard XYZ D50 → ProPhoto via inverse of ProPhoto→XYZ D50.
        M_PRO_TO_XYZ_D50.inverse().expect("ProPhoto matrix is invertible")
    });
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&fm).mul_mat(&adapt).mul_mat(&cam_to_xyz);

    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in camera.pixels.iter().enumerate() {
        out.pixels[i] = m.mul_vec(*p);
    }
    Ok(out)
}

// ── Dual-illuminant reciprocal-CCT interpolation ─────────────────────────────

/// Build a color-temperature-specific profile by interpolating between two
/// illuminants' calibration matrices. Reciprocal-CCT lerp per spec § 3.4.
fn interpolate_cm(
    m1: Matrix3, cct1: f32,
    m2: Matrix3, cct2: f32,
    cct_target: f32,
) -> Matrix3 {
    if (cct1 - cct2).abs() < 1.0 {
        return m1; // degenerate — same illuminants
    }
    let inv_t1 = 1.0 / cct1;
    let inv_t2 = 1.0 / cct2;
    let inv_target = 1.0 / cct_target;
    let t = ((inv_target - inv_t1) / (inv_t2 - inv_t1)).clamp(0.0, 1.0);
    // Element-wise lerp: (1-t)*m1 + t*m2
    let a = &m1.0;
    let b = &m2.0;
    let mut out = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (1.0 - t) * a[i][j] + t * b[i][j];
        }
    }
    Matrix3(out)
}

/// Compute as-shot CCT from the camera's white balance coefficients and
/// two calibration CM matrices. Iterative refinement per DNG spec / RawTherapee:
///   - guess CCT
///   - interpolate CM → XYZ_from_camera
///   - XYZ = inv(CM) * wb_neutral
///   - xy → CCT via McCamy's formula
///   - repeat
fn compute_as_shot_cct(
    wb_neutral: [f32; 3],
    m_cold: Matrix3, cct_cold: f32,
    m_warm: Matrix3, cct_warm: f32,
) -> f32 {
    let mut cct = (cct_cold + cct_warm) * 0.5; // initial guess
    for _ in 0..3 {
        let cm = interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, cct);
        let cm_inv = match cm.inverse() {
            Some(inv) => inv,
            None => return cct, // degenerate; return current guess
        };
        let xyz = cm_inv.mul_vec(wb_neutral);
        let sum = xyz[0] + xyz[1] + xyz[2];
        if sum < 1e-6 { return cct; }
        let x = xyz[0] / sum;
        let y = xyz[1] / sum;
        // McCamy's formula for CCT from xy.
        let n = (x - 0.3320) / (0.1858 - y);
        cct = 437.0 * n.powi(3) + 3601.0 * n.powi(2) + 6861.0 * n + 5517.0;
        cct = cct.clamp(2000.0, 15000.0);
    }
    cct
}

/// Build a profile by interpolating between two illuminants, using the
/// camera's as-shot neutral to compute the scene CCT. Used when rawler's
/// color_matrix HashMap has 2+ entries.
pub fn interpolated_profile(
    m_cold: Matrix3, illum_cold: Illuminant,
    m_warm: Matrix3, illum_warm: Illuminant,
    wb_neutral: [f32; 3],
) -> DcpProfile {
    let cct_cold = illum_cold.cct();
    let cct_warm = illum_warm.cct();
    let as_shot_cct = compute_as_shot_cct(wb_neutral, m_cold, cct_cold, m_warm, cct_warm);
    let cm = interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, as_shot_cct);
    DcpProfile {
        illuminant: if (cct_cold - as_shot_cct).abs() < (cct_warm - as_shot_cct).abs() {
            illum_cold
        } else {
            illum_warm
        },
        color_matrix: cm,
        forward_matrix: None,
    }
}

// ── profile_for ───────────────────────────────────────────────────────────────

/// Synthesize a `DcpProfile` from a `RawImage`'s embedded color matrices.
///
/// Prefers dual-illuminant reciprocal-CCT interpolation (spec § 3.4) when
/// both a warm illuminant (StdA) and a cool illuminant (D65/D55) are present.
/// Falls back to single-illuminant (D65 → D50 → D55 → StdA → any) when only
/// one matrix is available.
pub fn profile_for(raw: &RawImage) -> crate::Result<DcpProfile> {
    // Prefer two-illuminant interpolation when we have CMs at both ends of
    // the typical range (cold illuminant like StdA, warm like D65).
    let cold_candidates = [Illuminant::StdA, Illuminant::D50];
    let warm_candidates = [Illuminant::D65, Illuminant::D55, Illuminant::D50];

    let cold = cold_candidates.iter()
        .find_map(|i| raw.color_matrices.get(i).map(|m| (*i, *m)));
    let warm = warm_candidates.iter()
        .find_map(|i| raw.color_matrices.get(i).map(|m| (*i, *m)));

    if let (Some((il_cold, m_cold)), Some((il_warm, m_warm))) = (cold, warm) {
        if il_cold != il_warm {
            return Ok(interpolated_profile(
                m_cold, il_cold,
                m_warm, il_warm,
                raw.as_shot_neutral,
            ));
        }
    }

    // Single-illuminant fallback: prefer D65, then D50, then anything.
    let preferred = [Illuminant::D65, Illuminant::D50, Illuminant::D55, Illuminant::StdA];
    for illum in preferred {
        if let Some(cm) = raw.color_matrices.get(&illum) {
            return Ok(DcpProfile {
                illuminant: illum,
                color_matrix: *cm,
                forward_matrix: None,
            });
        }
    }
    // Any remaining illuminant, deterministic iteration order (sorted by debug name).
    let mut entries: Vec<_> = raw.color_matrices.iter().collect();
    entries.sort_by_key(|(illum, _)| format!("{:?}", illum));
    if let Some((illum, cm)) = entries.first() {
        return Ok(DcpProfile {
            illuminant: **illum,
            color_matrix: **cm,
            forward_matrix: None,
        });
    }
    Err(crate::Error::Dcp(format!(
        "no embedded color matrix for {} {}",
        raw.camera_make, raw.camera_model
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_raw(cms: std::collections::HashMap<Illuminant, Matrix3>) -> RawImage {
        RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
        }
    }

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
        let out = apply(&img, &profile).expect("identity CM is invertible");
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
        let out = apply(&img, &profile).expect("realistic CM is invertible");
        assert_eq!(out.space, ColorSpace::SceneLinearRec2020);
        // Output is finite.
        for &c in &out.pixels[0] {
            assert!(c.is_finite());
        }
    }

    #[test]
    fn profile_for_returns_err_when_no_matrix() {
        let raw = make_raw(std::collections::HashMap::new());
        let err = profile_for(&raw).unwrap_err();
        match err {
            crate::Error::Dcp(_) => {}
            other => panic!("expected Error::Dcp, got {:?}", other),
        }
    }

    #[test]
    fn profile_for_succeeds_when_matrix_present() {
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, Matrix3::IDENTITY);
        let raw = make_raw(cms);
        let profile = profile_for(&raw).unwrap();
        assert_eq!(profile.illuminant, Illuminant::D65);
        assert_eq!(profile.color_matrix, Matrix3::IDENTITY);
        assert!(profile.forward_matrix.is_none());
    }

    // ── New dual-illuminant tests ─────────────────────────────────────────────

    #[test]
    fn cct_interpolation_lerps_reciprocally() {
        let m1 = Matrix3::IDENTITY;
        let m2 = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        // Midpoint in reciprocal CCT is at 1/cct_mid = (1/cct_cold + 1/cct_warm)/2
        let cct_mid = 2.0 / (1.0 / 2856.0 + 1.0 / 6504.0);
        let interp = interpolate_cm(m1, 2856.0, m2, 6504.0, cct_mid);
        // At reciprocal-midpoint, t=0.5, so interp = 0.5*m1 + 0.5*m2 = 1.5*I.
        assert!((interp.0[0][0] - 1.5).abs() < 1e-4);
        assert!((interp.0[1][1] - 1.5).abs() < 1e-4);
    }

    #[test]
    fn cct_interpolation_pins_at_endpoints() {
        let m1 = Matrix3::IDENTITY;
        let m2 = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        let at_cold = interpolate_cm(m1, 2856.0, m2, 6504.0, 2856.0);
        let at_warm = interpolate_cm(m1, 2856.0, m2, 6504.0, 6504.0);
        assert_eq!(at_cold.0[0][0], 1.0);
        assert_eq!(at_warm.0[0][0], 2.0);
    }

    #[test]
    fn cct_interpolation_clamps_outside_endpoints() {
        let m1 = Matrix3::IDENTITY;
        let m2 = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        // Target below cold — t should clamp to 0 → m1.
        let cooler = interpolate_cm(m1, 2856.0, m2, 6504.0, 2000.0);
        assert_eq!(cooler.0[0][0], 1.0);
        // Target above warm — t should clamp to 1 → m2.
        let hotter = interpolate_cm(m1, 2856.0, m2, 6504.0, 10000.0);
        assert_eq!(hotter.0[0][0], 2.0);
    }

    #[test]
    fn profile_for_interpolates_when_two_illuminants_available() {
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, Matrix3::IDENTITY);
        cms.insert(Illuminant::D65, Matrix3([
            [2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0],
        ]));
        let raw = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
        };
        let profile = profile_for(&raw).unwrap();
        // Neutral (1,1,1) camera neutral → should land near D65 CCT → interpolated
        // CM should be between identity (StdA) and 2*identity (D65).
        assert!(profile.color_matrix.0[0][0] > 1.0);
        assert!(profile.color_matrix.0[0][0] < 2.0);
    }
}
