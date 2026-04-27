use crate::{
    color::{
        hsm::{self, HsmTable},
        illuminant::Illuminant,
        matrices::{M_PRO_TO_XYZ_D50, XYZ_D50, bradford_adapt, m_pro_to_rec2020},
    },
    image::{ColorSpace, Image, RawImage},
    math::Matrix3,
};
use rayon::prelude::*;

// Re-export Illuminant so existing code that imported it from dcp keeps working.
pub use crate::color::illuminant::Illuminant as DcpIlluminant;

/// Minimal DCP for slice 1+. Spec § 3.4 subset:
///   single (or interpolated) illuminant, CM (camera → XYZ), optional FM (XYZ D50 → ProPhoto).
/// No HueSatMap, no ProfileLookTable. Those land in a later slice per the roadmap.
#[derive(Clone, Debug)]
pub struct DcpProfile {
    /// The calibration illuminant tag — retained for debugging / profile
    /// identification. **Not** used as the Bradford source: see `scene_cct`.
    pub illuminant: Illuminant,
    /// Camera RGB → XYZ at the scene illuminant (post-interpolation for dual-
    /// CM profiles; the raw calibration CM for single-CM profiles). Spec § 3.4
    /// step 1.
    pub color_matrix: Matrix3,
    /// XYZ D50 → ProPhoto RGB. Optional per DNG spec. When present, Bradford
    /// CA is skipped — FM absorbs it (spec § 3.4 step 2). When absent, we
    /// Bradford from `scene_white_xyz` to D50 and fall back to the inverse
    /// of `M_PRO_TO_XYZ_D50`.
    pub forward_matrix: Option<Matrix3>,
    /// Correlated color temperature of the scene illuminant in Kelvin, derived
    /// iteratively from AsShotNeutral + calibration matrices. Not itself used
    /// by `apply` — see `scene_white_xyz` — but retained for debugging /
    /// reporting. Spec § 3.4.
    pub scene_cct: f32,
    /// Scene illuminant's white point in CIE XYZ, normalized to Y = 1.
    /// Computed as `normalize(inv(CM_interp) * AsShotNeutral)`. This is the
    /// Bradford source in the FM-absent path — by construction, a neutral
    /// camera reading passed through `apply` renders exactly neutral in D50,
    /// avoiding the McCamy↔Hernández polynomial round-trip residual.
    pub scene_white_xyz: crate::math::Vec3,
    /// True when the source image already has its white balance baked in by
    /// the converter (e.g. LinearRaw DNGs, where AsShotNeutral was applied
    /// at write-time). When set, `scene_white_xyz` is derived from
    /// `inv(CM) · (1, 1, 1)` instead of `inv(CM) · as_shot_neutral`,
    /// preventing a double WB application. See ticket #07.
    pub wb_already_baked: bool,
    /// Per-illuminant ProfileHueSatMap, already lerped to `scene_cct` when
    /// the source DNG ships both `ProfileHueSatMapData1` and
    /// `ProfileHueSatMapData2` (DNG 1.6 § 6.6.5). When only one is present,
    /// it's used as-is regardless of CCT (the spec's single-illuminant
    /// case). When neither is present (vendor RAW, or DNG without HSM),
    /// this is `None` and `apply` skips the HSM stage. The table is applied
    /// in ProPhoto-D50 space, between the chromatic adaptation step and
    /// the gamut conversion to Rec.2020 — the same point in the chain
    /// the DNG SDK reference uses (`dng_color_spec.cpp`).
    pub hsm: Option<HsmTable>,
}

impl DcpProfile {
    /// Build a minimal DCP from an embedded ColorMatrix with the
    /// assumption it's D65. Used for rawler-decoded fixtures where we
    /// preferred the D65 (or D50) illuminant in decode.rs. Spec § 3.4
    /// edge case: "Profile has only CM1/CM2 — use standard D50 Bradford
    /// adapt from XYZ to ProPhoto."
    pub fn from_embedded_cm(cm: Matrix3) -> Self {
        // Assume unit as-shot neutral — the only honest default when we have
        // no AsShotNeutral information. Self-consistent neutral scene white
        // via the same derivation profile_for uses: inv(cm) * [1,1,1],
        // normalized to Y=1.
        let scene_white_xyz = normalize_to_y1(
            cm.inverse().unwrap_or(Matrix3::IDENTITY).mul_vec([1.0, 1.0, 1.0])
        );
        Self {
            illuminant: Illuminant::D65,
            color_matrix: cm,
            forward_matrix: None,
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz,
            // Embedded-CM constructors don't know whether the source is
            // LinearRaw; default to false (the Bayer / vendor-RAW case).
            // `profile_for` overrides this for actual LinearRaw inputs.
            wb_already_baked: false,
            // No HSM available from a bare embedded CM; profile_for fills
            // this in for real DNGs that ship the tags.
            hsm: None,
        }
    }
}

/// Rescale an XYZ vector so Y = 1. Degenerate Y=0 falls back to D65.
fn normalize_to_y1(xyz: crate::math::Vec3) -> crate::math::Vec3 {
    if xyz[1].abs() < 1e-8 {
        return crate::color::matrices::XYZ_D65;
    }
    let s = 1.0 / xyz[1];
    [xyz[0] * s, 1.0, xyz[2] * s]
}

/// Apply DCP to camera-native linear RGB, producing scene-linear Rec.2020 D65.
/// Single-illuminant and interpolated-dual-illuminant profiles both flow
/// through this path; single-CM skips the interpolation but uses the same
/// Bradford / FM logic.
///
/// DNG's `ColorMatrix` is defined `XYZ → camera`; for decoding we use its
/// inverse (spec § 3.4 step 1). The chromatic adaptation to D50 (step 2)
/// uses the **scene illuminant's** white point derived from `scene_cct`,
/// not the nearer calibration illuminant — that distinction is what drives
/// the per-fixture color cast when omitted. When `forward_matrix` is
/// present, Bradford is skipped entirely: FM absorbs the CA per spec.
///
/// When `profile.hsm` is `Some`, the ProfileHueSatMap is applied in
/// ProPhoto-D50 space (per DNG SDK reference `dng_color_spec.cpp` —
/// HueSatMap operates in the profile's working space, which the DNG spec
/// defines as RIMM-RGB / linear ProPhoto D50). The result then projects
/// to Rec.2020 D65 via `m_pro_to_rec2020`. When `None`, the camera→Rec.2020
/// chain folds into a single matrix multiply per pixel — the original
/// (pre-Ticket-10c) fast path.
pub fn apply(camera: &Image, profile: &DcpProfile) -> crate::Result<Image> {
    apply_with_post_pro(camera, profile, None)
}

/// Internal: same as [`apply`] but lets the caller hook in a second table
/// (the ProfileLookTable) that runs in the same ProPhoto-D50 space, right
/// after HSM. PLT is conceptually a "look" baked into the profile and per
/// spec § 6.7 also belongs in the camera profile's working space.
///
/// This unification matters when both HSM and PLT are present: we avoid
/// going Camera → ProPhoto → apply HSM → Rec.2020 → apply PLT (which would
/// require PLT to "see" Rec.2020 RGB), keeping both stages in their proper
/// linear-ProPhoto-D50 space.
pub fn apply_with_plt(
    camera: &Image,
    profile: &DcpProfile,
    plt: Option<&hsm::HsmTable>,
) -> crate::Result<Image> {
    apply_with_post_pro(camera, profile, plt)
}

fn apply_with_post_pro(
    camera: &Image,
    profile: &DcpProfile,
    post_pro: Option<&hsm::HsmTable>,
) -> crate::Result<Image> {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);

    let cam_to_xyz = profile.color_matrix.inverse().ok_or_else(|| {
        crate::Error::Dcp("ColorMatrix is singular, cannot invert to camera→XYZ".into())
    })?;

    // Camera RGB → ProPhoto D50: identical algebra to the original
    // single-matrix path, just stopped one matrix earlier so we can run
    // HSM and/or PLT in ProPhoto space when present.
    let cam_to_pro = if let Some(fm) = profile.forward_matrix {
        // FM is XYZ_scene → ProPhoto D50 with CA baked in.
        fm.mul_mat(&cam_to_xyz)
    } else {
        // Bradford-adapt from the scene white to D50, then inverse-ProPhoto
        // to enter ProPhoto D50. See the `apply` doc on this same file
        // for why scene_white_xyz is the right Bradford source.
        let adapt = bradford_adapt(profile.scene_white_xyz, XYZ_D50);
        let inv_pro = M_PRO_TO_XYZ_D50.inverse().expect("ProPhoto matrix is invertible");
        inv_pro.mul_mat(&adapt).mul_mat(&cam_to_xyz)
    };

    let needs_pro_intermediate = profile.hsm.is_some() || post_pro.is_some();
    if needs_pro_intermediate {
        // Slow path: project to ProPhoto D50, run HSM and/or PLT, then
        // project to Rec.2020 D65. Cost: two matmuls + 0..2 HSM lookups
        // per pixel, vs one matmul on the fast path. The intermediate
        // `Image` is tagged `CameraNativeLinearRgb` only because we don't
        // have a `ProPhotoLinearD50` color-space variant — `hsm::apply`
        // doesn't enforce a tag, only the data layout.
        let mut pro = Image::new(camera.width, camera.height, ColorSpace::CameraNativeLinearRgb);
        pro.pixels
            .par_iter_mut()
            .zip(camera.pixels.par_iter())
            .for_each(|(o, p)| { *o = cam_to_pro.mul_vec(*p); });
        if let Some(table) = profile.hsm.as_ref() {
            hsm::apply(&mut pro, table);
        }
        if let Some(table) = post_pro {
            hsm::apply(&mut pro, table);
        }
        let exit = m_pro_to_rec2020();
        let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
        out.pixels
            .par_iter_mut()
            .zip(pro.pixels.par_iter())
            .for_each(|(o, p)| { *o = exit.mul_vec(*p); });
        return Ok(out);
    }

    // Fast path: no HSM, no PLT. Fold cam_to_pro and exit into one matrix.
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&cam_to_pro);
    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    out.pixels
        .par_iter_mut()
        .zip(camera.pixels.par_iter())
        .for_each(|(o, p)| { *o = m.mul_vec(*p); });
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

/// Single-CM variant of [`compute_as_shot_cct`]. No interpolation step — the
/// CM is fixed, so derive the scene CCT directly from `inv(CM) * wb_neutral`.
/// Used by the single-illuminant fallback in [`profile_for`] so that the
/// Bradford source white still comes from the *scene*, not the sole
/// calibration illuminant.
fn compute_scene_cct_single(cm: Matrix3, wb_neutral: [f32; 3], fallback: f32) -> f32 {
    let cm_inv = match cm.inverse() {
        Some(inv) => inv,
        None => return fallback,
    };
    let xyz = cm_inv.mul_vec(wb_neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum < 1e-6 { return fallback; }
    let x = xyz[0] / sum;
    let y = xyz[1] / sum;
    let n = (x - 0.3320) / (0.1858 - y);
    let cct = 437.0 * n.powi(3) + 3601.0 * n.powi(2) + 6861.0 * n + 5517.0;
    cct.clamp(2000.0, 15000.0)
}

/// Build a profile by interpolating between two illuminants, using the
/// camera's as-shot neutral to compute the scene CCT. Used when rawler's
/// color_matrix HashMap has 2+ entries.
///
/// `wb_already_baked = true` for LinearRaw DNGs whose converter pre-applied
/// AsShotNeutral. In that case `scene_white_xyz` derives from
/// `inv(CM) · (1, 1, 1)` instead of `inv(CM) · wb_neutral`, preventing the
/// `dcp::apply` Bradford from re-applying WB on top of the bake. The CCT
/// estimate still uses `wb_neutral` because the ShotNeutral metadata still
/// records the scene illuminant correctly. See ticket #07.
///
/// `hsm_cold` / `hsm_warm` are the corresponding ProfileHueSatMapData1/2
/// tables. When both are present and shape-compatible, they're lerped per
/// reciprocal CCT (DNG 1.6 § 6.6.5) using the SAME parameter `t` derived
/// from `as_shot_cct`. When only one is present, it's used as-is. When
/// neither is present, the resulting profile carries `hsm = None`.
pub fn interpolated_profile(
    m_cold: Matrix3, illum_cold: Illuminant,
    m_warm: Matrix3, illum_warm: Illuminant,
    wb_neutral: [f32; 3],
    wb_already_baked: bool,
    hsm_cold: Option<&HsmTable>,
    hsm_warm: Option<&HsmTable>,
) -> DcpProfile {
    let cct_cold = illum_cold.cct();
    let cct_warm = illum_warm.cct();
    let as_shot_cct = compute_as_shot_cct(wb_neutral, m_cold, cct_cold, m_warm, cct_warm);
    let cm = interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, as_shot_cct);
    // The pipeline is NOT pre-gaining camera RGB (WB pre-gain deferred until
    // paired with per-body BaselineExposure + HSM — see pipeline.rs comment).
    // In the no-pre-gain world, a neutral scene patch enters inv(CM) as
    // AsShotNeutral, so the self-consistent Bradford source is
    // `inv(CM_interp) * AsShotNeutral`, normalized to Y=1. For LinearRaw
    // sources (wb_already_baked = true) the converter pre-applied WB, so a
    // neutral patch enters inv(CM) as (1, 1, 1) instead.
    let neutral_for_white = if wb_already_baked { [1.0, 1.0, 1.0] } else { wb_neutral };
    let scene_white_xyz = cm.inverse()
        .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
        .unwrap_or(crate::color::matrices::XYZ_D65);
    let hsm = lerp_hsm_for_cct(hsm_cold, hsm_warm, cct_cold, cct_warm, as_shot_cct);
    DcpProfile {
        illuminant: if (cct_cold - as_shot_cct).abs() < (cct_warm - as_shot_cct).abs() {
            illum_cold
        } else {
            illum_warm
        },
        color_matrix: cm,
        forward_matrix: None,
        scene_cct: as_shot_cct,
        scene_white_xyz,
        wb_already_baked,
        hsm,
    }
}

/// Pick or interpolate an HSM table for a target scene CCT, mirroring the
/// reciprocal-CCT algorithm in `interpolate_cm`. Used by both
/// `interpolated_profile` (dual-illuminant DCP path) and `profile_for`
/// (single-illuminant fallback that may still ship one HSM).
///
/// Returns `None` only when both inputs are `None` or when a dual table
/// pair has incompatible dims/encoding (in which case we conservatively
/// pick the cold table; HSM failure shouldn't break decode).
fn lerp_hsm_for_cct(
    hsm_cold: Option<&HsmTable>,
    hsm_warm: Option<&HsmTable>,
    cct_cold: f32, cct_warm: f32,
    cct_target: f32,
) -> Option<HsmTable> {
    match (hsm_cold, hsm_warm) {
        (Some(c), Some(w)) => {
            // Same `t` formula used by `interpolate_cm`, kept inline so the
            // two functions can drift together if the CCT model ever changes.
            if (cct_cold - cct_warm).abs() < 1.0 {
                return Some(c.clone());
            }
            let inv_t1 = 1.0 / cct_cold;
            let inv_t2 = 1.0 / cct_warm;
            let inv_target = 1.0 / cct_target;
            let t = ((inv_target - inv_t1) / (inv_t2 - inv_t1)).clamp(0.0, 1.0);
            // If shapes don't match (rare malformed DNG), fall back to the
            // cold table — applying a same-shape mismatch ratio would crash.
            hsm::lerp_tables(c, w, t).or_else(|| Some(c.clone()))
        }
        (Some(c), None) => Some(c.clone()),
        (None, Some(w)) => Some(w.clone()),
        (None, None) => None,
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
    // For LinearRaw DNGs, `linearize::linearraw_to_camera_rgb` undoes the
    // converter's AsShotNeutral pre-bake by multiplying each channel by
    // AsShotNeutral. The resulting camera-RGB is in the same space the
    // Bayer path produces (neutral patch reads as AsShotNeutral), so
    // `scene_white_xyz = inv(CM) · AsShotNeutral` is correct for both.
    // The `wb_already_baked` flag stays FALSE here; it's reserved for
    // hypothetical future variants that hand WB-baked input directly to
    // `dcp::apply` (no pre-bake undo). See ticket #07.
    let wb_already_baked = false;
    let neutral_for_white: [f32; 3] = raw.as_shot_neutral;

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
                wb_already_baked,
                raw.hsm_data1.as_ref(),
                raw.hsm_data2.as_ref(),
            ));
        }
    }

    // Single-illuminant HSM resolution. If only one of HSM1/HSM2 is present,
    // use it directly; if both are present (rare in single-CM profiles —
    // shouldn't happen, but tolerate), prefer HSM1 (the cold-side per spec
    // convention). For the dual-CM path above, the proper reciprocal lerp
    // runs inside `interpolated_profile`.
    let single_hsm: Option<HsmTable> = raw.hsm_data1.clone().or_else(|| raw.hsm_data2.clone());

    // Single-illuminant fallback: prefer D65, then D50, then anything. The
    // scene CCT is still derived from AsShotNeutral + the lone CM (spec § 3.4
    // "Profile has only one illuminant — skip interpolation; use it directly"
    // — but Bradford source is still the scene white, not the calibration
    // white, so fix 1+2 collapses to the same code path as the dual-CM case).
    let preferred = [Illuminant::D65, Illuminant::D50, Illuminant::D55, Illuminant::StdA];
    for illum in preferred {
        if let Some(cm) = raw.color_matrices.get(&illum) {
            let scene_cct = compute_scene_cct_single(*cm, raw.as_shot_neutral, illum.cct());
            let scene_white_xyz = cm.inverse()
                .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
                .unwrap_or(crate::color::matrices::XYZ_D65);
            return Ok(DcpProfile {
                illuminant: illum,
                color_matrix: *cm,
                forward_matrix: None,
                scene_cct,
                scene_white_xyz,
                wb_already_baked,
                hsm: single_hsm,
            });
        }
    }
    // Any remaining illuminant, deterministic iteration order (sorted by debug name).
    let mut entries: Vec<_> = raw.color_matrices.iter().collect();
    entries.sort_by_key(|(illum, _)| format!("{:?}", illum));
    if let Some((illum, cm)) = entries.first() {
        let scene_cct = compute_scene_cct_single(**cm, raw.as_shot_neutral, illum.cct());
        let scene_white_xyz = cm.inverse()
            .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
            .unwrap_or(crate::color::matrices::XYZ_D65);
        return Ok(DcpProfile {
            illuminant: **illum,
            color_matrix: **cm,
            forward_matrix: None,
            scene_cct,
            scene_white_xyz,
            wb_already_baked,
            hsm: single_hsm,
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
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
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
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz: crate::color::matrices::XYZ_D65,
            wb_already_baked: false,
            hsm: None,
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

    /// RED test for DCP fix 1+2 (Bradford from scene CCT, unified path).
    /// A neutral patch at an off-calibration scene CCT must render neutral.
    /// Failure mode this catches: Bradford adapted from nearest-calibration
    /// illuminant instead of the scene illuminant leaves residual chroma.
    ///
    #[test]
    fn neutral_patch_at_scene_illuminant_renders_approximately_neutral() {
        // Two plausibly-shaped CM matrices at StdA and D65.
        let cm_a = Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ]);
        let cm_d = Matrix3([
            [ 0.5000, -0.0500, -0.1100],
            [-0.3500,  1.3100,  0.1900],
            [-0.0300,  0.2100,  0.6200],
        ]);

        // Scene at 4500K: Hernández-Andrés polynomial → (x, y) → XYZ (Y=1).
        let cct = 4500.0f32;
        let x = 0.244_063
              + 99.11 / cct
              + 2_967_800.0 / (cct * cct)
              - 4_607_000_000.0 / (cct * cct * cct);
        let y = -3.0 * x * x + 2.870 * x - 0.275;
        let xyz_scene: crate::math::Vec3 = [x / y, 1.0, (1.0 - x - y) / y];

        // Simulate the camera reading of a neutral patch at 4500K:
        // camera_rgb = CM_interp * XYZ_scene, where CM_interp is the
        // reciprocal-CCT lerp between StdA (2856K) and D65 (6504K).
        let t = (1.0/cct - 1.0/2856.0) / (1.0/6504.0 - 1.0/2856.0);
        let cm_interp = {
            let a = &cm_a.0;
            let b = &cm_d.0;
            let mut m = [[0.0f32; 3]; 3];
            for i in 0..3 {
                for j in 0..3 {
                    m[i][j] = (1.0 - t) * a[i][j] + t * b[i][j];
                }
            }
            Matrix3(m)
        };
        let as_shot_neutral = cm_interp.mul_vec(xyz_scene);

        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, cm_a);
        cms.insert(Illuminant::D65, cm_d);
        let raw = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
        };
        let profile = profile_for(&raw).unwrap();

        // Pipeline does NOT pre-gain; neutral pixel enters inv(CM) as
        // AsShotNeutral. Self-consistent test: inv(CM) * AsShotNeutral
        // gives XYZ_scene_white, Bradford(that → D50) gives D50 white,
        // downstream matrices give neutral Rec.2020.
        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = as_shot_neutral;
        let out = apply(&img, &profile).unwrap();
        let p = out.pixels[0];

        let rg = (p[0] - p[1]).abs();
        let bg = (p[2] - p[1]).abs();
        assert!(rg < 0.005 && bg < 0.005,
            "not neutral: RGB = ({:.4}, {:.4}, {:.4}), |R-G|={:.4}, |B-G|={:.4}",
            p[0], p[1], p[2], rg, bg);
    }

    /// Regression test for ticket #07 (LinearRaw WB double-apply fix).
    /// `linearize::linearraw_to_camera_rgb` undoes the converter's
    /// AsShotNeutral pre-bake (multiplying each channel by AsShotNeutral) so
    /// the data delivered to `dcp::apply` is in the same camera-RGB space
    /// the Bayer path produces. As a result `profile_for` produces the
    /// SAME `scene_white_xyz` for a LinearRgb raw as for the Bayer
    /// equivalent — both use `inv(CM) · AsShotNeutral`. The
    /// `DcpProfile::wb_already_baked` flag stays `false` for the LinearRgb
    /// path; it's reserved for hypothetical future callers that hand
    /// already-baked data directly to `dcp::apply`.
    #[test]
    fn linearraw_profile_matches_bayer_after_pre_bake_undo() {
        let cm = Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ]);
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, cm);
        let warm_wb: [f32; 3] = [1.65, 1.0, 2.16]; // Canon-shape AsShotNeutral

        let raw_linear = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::LinearRgb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0; 3], // 1 px × 3 channels
            as_shot_neutral: warm_wb,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms.clone(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
        };
        let prof_linear = profile_for(&raw_linear).unwrap();
        // Pre-bake undo lives in linearize::linearraw_to_camera_rgb, not in
        // profile_for. The flag stays false for LinearRgb sources.
        assert!(!prof_linear.wb_already_baked,
            "wb_already_baked must remain false; pre-bake undo runs in linearize");

        // For comparison: a Bayer raw with the same CM + WB must produce
        // the SAME scene_white_xyz, because both paths now hand camera RGB
        // with neutrals = AsShotNeutral to dcp::apply.
        let mut raw_bayer = raw_linear.clone();
        raw_bayer.cfa = crate::image::CfaPattern::Rggb;
        let prof_bayer = profile_for(&raw_bayer).unwrap();
        assert!(!prof_bayer.wb_already_baked);
        for i in 0..3 {
            assert!((prof_linear.scene_white_xyz[i] - prof_bayer.scene_white_xyz[i]).abs() < 1e-5,
                "LinearRgb and Bayer profiles must produce the SAME scene_white_xyz; \
                 LinearRgb={:?}, Bayer={:?}",
                prof_linear.scene_white_xyz, prof_bayer.scene_white_xyz);
        }

        // Self-consistency check: scene_white_xyz really is inv(CM) · AsShotNeutral / Y_normalized.
        let inv_cm = cm.inverse().unwrap();
        let xyz = inv_cm.mul_vec(warm_wb);
        let s = 1.0 / xyz[1];
        let expected = [xyz[0] * s, 1.0, xyz[2] * s];
        for i in 0..3 {
            assert!((prof_linear.scene_white_xyz[i] - expected[i]).abs() < 1e-4,
                "scene_white_xyz[{}] = {} (want inv(CM)·AsShotNeutral = {})",
                i, prof_linear.scene_white_xyz[i], expected[i]);
        }
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
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
        };
        let profile = profile_for(&raw).unwrap();
        // Neutral (1,1,1) camera neutral → should land near D65 CCT → interpolated
        // CM should be between identity (StdA) and 2*identity (D65).
        assert!(profile.color_matrix.0[0][0] > 1.0);
        assert!(profile.color_matrix.0[0][0] < 2.0);
    }
}
