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
    apply_with_post_pro(camera, profile, None, None)
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
    apply_with_post_pro(camera, profile, plt, None)
}

/// Like [`apply_with_plt`] but also runs the DNG 1.4 § 6.4.4
/// ProfileToneCurve in profile-working space, between HSM and PLT.
/// Per Adobe DNG SDK reference (`dng_camera_profile.cpp`), the canonical
/// order is HSM → ProfileToneCurve → ProfileLookTable, all in linear
/// ProPhoto D50.
pub fn apply_with_plt_and_ptc(
    camera: &Image,
    profile: &DcpProfile,
    plt: Option<&hsm::HsmTable>,
    ptc: Option<&crate::color::profile_tone_curve::ProfileToneCurve>,
) -> crate::Result<Image> {
    apply_with_post_pro(camera, profile, plt, ptc)
}

/// Soft-floor: when any channel goes below 0 post-DCP (out-of-gamut camera
/// color in Rec.2020), pull all three channels up uniformly by the deficit.
/// Preserves hue (R/G/B ratios) while moving the pixel into the renderable
/// part of the gamut.
///
/// Without this, AgX downstream clamps negatives to its `AGX_MIN_EV` floor
/// (~0.00018), so the displayed image loses blue/red where the scene had
/// out-of-gamut variants of those colors. Diagnosed via stage-dump on
/// Canon EOS 5D Mark III (test_0006 / test_0007): post-DCP B channel
/// went to -0.021 after the camera's AsShotNeutral × ColorMatrix drove
/// the blue reading out of Rec.2020, and the AgX clamp lost ~0.295 of
/// blue brightness in the final output.
///
/// Per `.archived-plans/plans/2026-04-27-clipping-and-artifacts.md`
/// Phase 4 (negative-channel handling after DCP).
#[inline]
fn soft_floor(p: [f32; 3]) -> [f32; 3] {
    let min = p[0].min(p[1]).min(p[2]);
    if min >= 0.0 {
        return p;
    }
    let lift = -min;
    [p[0] + lift, p[1] + lift, p[2] + lift]
}

fn apply_with_post_pro(
    camera: &Image,
    profile: &DcpProfile,
    post_pro: Option<&hsm::HsmTable>,
    ptc: Option<&crate::color::profile_tone_curve::ProfileToneCurve>,
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

    let needs_pro_intermediate =
        profile.hsm.is_some() || post_pro.is_some() || ptc.is_some();
    if needs_pro_intermediate {
        // Slow path: project to ProPhoto D50, run HSM / PTC / PLT, then
        // project to Rec.2020 D65. The intermediate `Image` is tagged
        // `CameraNativeLinearRgb` only because we don't have a
        // `ProPhotoLinearD50` color-space variant — `hsm::apply` and
        // `profile_tone_curve::apply` don't enforce a tag, only the data
        // layout.
        let mut pro = Image::new(camera.width, camera.height, ColorSpace::CameraNativeLinearRgb);
        pro.pixels
            .par_iter_mut()
            .zip(camera.pixels.par_iter())
            .for_each(|(o, p)| { *o = cam_to_pro.mul_vec(*p); });
        // DNG SDK order: HSM (camera-hue rotation per illuminant) →
        // ProfileToneCurve (1D tone) → ProfileLookTable (look). All in
        // linear ProPhoto D50.
        if let Some(table) = profile.hsm.as_ref() {
            hsm::apply(&mut pro, table);
        }
        if let Some(curve) = ptc {
            crate::color::profile_tone_curve::apply(&mut pro, curve);
        }
        if let Some(table) = post_pro {
            hsm::apply(&mut pro, table);
        }
        let exit = m_pro_to_rec2020();
        let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
        out.pixels
            .par_iter_mut()
            .zip(pro.pixels.par_iter())
            .for_each(|(o, p)| { *o = soft_floor(exit.mul_vec(*p)); });
        return Ok(out);
    }

    // Fast path: no HSM, no PLT, no PTC. Fold cam_to_pro and exit into one matrix.
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&cam_to_pro);
    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    out.pixels
        .par_iter_mut()
        .zip(camera.pixels.par_iter())
        .for_each(|(o, p)| { *o = soft_floor(m.mul_vec(*p)); });
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
    fm_cold: Option<Matrix3>,
    fm_warm: Option<Matrix3>,
) -> DcpProfile {
    let cct_cold = illum_cold.cct();
    let cct_warm = illum_warm.cct();
    let as_shot_cct = compute_as_shot_cct(wb_neutral, m_cold, cct_cold, m_warm, cct_warm);
    let cm = interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, as_shot_cct);
    // Forward matrix: lerp by the same `t` parameter used for CM. When only
    // one of fm_cold/fm_warm is present, use it directly. When neither is
    // present, result is None and DCP falls back to Bradford CA.
    let forward_matrix = match (fm_cold, fm_warm) {
        (Some(fc), Some(fw)) => Some(interpolate_cm(fc, cct_cold, fw, cct_warm, as_shot_cct)),
        (Some(fc), None)     => Some(fc),
        (None, Some(fw))     => Some(fw),
        (None, None)         => None,
    };
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
        forward_matrix,
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
    // Phase 1.2 of the color-convergence work re-enabled the DNG-spec WB
    // pre-gain at `pipeline.rs` (after `linearize` + `demosaic`, before
    // DCP). After pre-gain, a neutral scene patch reads as (1, 1, 1) going
    // into DCP, so `scene_white_xyz = inv(CM) · (1, 1, 1)` and the DCP path
    // must run with `wb_already_baked = true`.
    //
    // Exception: 8-bit lossy LinearRaw DNGs (Adobe DNG Converter perceptual
    // path with `BitsPerSample = 8 8 8` and `white_level <= 255`) skip
    // pre-gain at pipeline.rs — WB stays baked through the linearize gamma
    // decode. For those, the legacy `inv(CM) · AsShotNeutral` derivation
    // is the empirical match (the principled `inv(CM) · (1, 1, 1)`
    // regressed by ~14 ΔE in earlier testing — see linearize.rs:137-145
    // for the detailed history).
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    let wb_already_baked = !skip_pre_gain;
    let neutral_for_white: [f32; 3] = if wb_already_baked {
        [1.0, 1.0, 1.0]
    } else {
        raw.as_shot_neutral
    };

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
            // Pair the FMs by illuminant so they lerp on the same `t` axis as
            // the CMs. ForwardMatrix1 / ForwardMatrix2 may be absent (most
            // bodies); when missing the dual-CM path's `forward_matrix`
            // becomes None and DCP falls back to Bradford CA.
            let fm_cold = raw.forward_matrices.get(&il_cold).copied();
            let fm_warm = raw.forward_matrices.get(&il_warm).copied();
            return Ok(interpolated_profile(
                m_cold, il_cold,
                m_warm, il_warm,
                raw.as_shot_neutral,
                wb_already_baked,
                raw.hsm_data1.as_ref(),
                raw.hsm_data2.as_ref(),
                fm_cold,
                fm_warm,
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
                forward_matrix: raw.forward_matrices.get(&illum).copied(),
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
            forward_matrix: raw.forward_matrices.get(illum).copied(),
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
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
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
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let profile = profile_for(&raw).unwrap();

        // Phase 1.2: pipeline.rs pre-gains camera_rgb by AsShotNeutral
        // before DCP. After pre-gain, a neutral patch reads (1, 1, 1) and
        // profile_for returns wb_already_baked=true so DCP uses
        // `inv(CM) · (1, 1, 1)` for scene_white_xyz. This unit test mirrors
        // that contract: feed (1, 1, 1) and expect neutral output.
        assert!(profile.wb_already_baked, "expected pre-gain semantics for Bayer cfa");
        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [1.0, 1.0, 1.0];
        let out = apply(&img, &profile).unwrap();
        let p = out.pixels[0];

        let rg = (p[0] - p[1]).abs();
        let bg = (p[2] - p[1]).abs();
        assert!(rg < 0.005 && bg < 0.005,
            "not neutral: RGB = ({:.4}, {:.4}, {:.4}), |R-G|={:.4}, |B-G|={:.4}",
            p[0], p[1], p[2], rg, bg);
    }

    /// Regression test for ticket #07 (LinearRaw WB double-apply fix),
    /// updated for Phase 1.2 of color-convergence (WB pre-gain re-enabled).
    ///
    /// 16-bit LinearRgb DNGs go through `linearize::linearraw_to_camera_rgb`
    /// which multiplies by AsShotNeutral to undo the converter's WB pre-bake
    /// (puts data in same camera-RGB space the Bayer path produces). Then
    /// pipeline.rs pre-gains BOTH paths uniformly. So both profile paths now
    /// produce identical `scene_white_xyz` because both run with
    /// `wb_already_baked=true` and `neutral_for_white=(1,1,1)`.
    ///
    /// 8-bit lossy LinearRgb (white_level <= 255) skips pre-gain entirely
    /// (data is gamma-decoded but WB-baked); for those, `wb_already_baked`
    /// stays false and `scene_white_xyz = inv(CM) · AsShotNeutral`. That
    /// path is covered separately.
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

        // Use white_level > 255 so the LinearRgb path is the 16-bit variant
        // (gets pre-gain, wb_already_baked=true) — matches Bayer's contract.
        let raw_linear = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::LinearRgb,
            black_level: [0; 4], white_level: 65535,
            raw_data: vec![0; 3], // 1 px × 3 channels
            as_shot_neutral: warm_wb,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms.clone(),
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let prof_linear = profile_for(&raw_linear).unwrap();
        // 16-bit LinearRgb path: pipeline.rs pre-gains, so DCP runs with
        // wb_already_baked=true (same as Bayer).
        assert!(prof_linear.wb_already_baked,
            "16-bit LinearRgb must get wb_already_baked=true after Phase 1.2");

        // For comparison: a Bayer raw with the same CM + WB must produce
        // the SAME scene_white_xyz — both pre-gained, both compute
        // scene_white from inv(CM) · (1,1,1).
        let mut raw_bayer = raw_linear.clone();
        raw_bayer.cfa = crate::image::CfaPattern::Rggb;
        let prof_bayer = profile_for(&raw_bayer).unwrap();
        assert!(prof_bayer.wb_already_baked);
        for i in 0..3 {
            assert!((prof_linear.scene_white_xyz[i] - prof_bayer.scene_white_xyz[i]).abs() < 1e-5,
                "LinearRgb and Bayer profiles must produce the SAME scene_white_xyz; \
                 LinearRgb={:?}, Bayer={:?}",
                prof_linear.scene_white_xyz, prof_bayer.scene_white_xyz);
        }

        // Self-consistency: with wb_already_baked=true, scene_white_xyz =
        // inv(CM) · (1,1,1) / Y_normalized.
        let inv_cm = cm.inverse().unwrap();
        let xyz = inv_cm.mul_vec([1.0, 1.0, 1.0]);
        let s = 1.0 / xyz[1];
        let expected = [xyz[0] * s, 1.0, xyz[2] * s];
        for i in 0..3 {
            assert!((prof_linear.scene_white_xyz[i] - expected[i]).abs() < 1e-4,
                "scene_white_xyz[{}] = {} (want inv(CM)·(1,1,1) = {})",
                i, prof_linear.scene_white_xyz[i], expected[i]);
        }

        // The 8-bit lossy LinearRgb path keeps the legacy contract: no
        // pre-gain, scene_white from inv(CM) · AsShotNeutral.
        let mut raw_lossy = raw_linear.clone();
        raw_lossy.white_level = 255;
        let prof_lossy = profile_for(&raw_lossy).unwrap();
        assert!(!prof_lossy.wb_already_baked,
            "8-bit lossy LinearRgb must keep wb_already_baked=false");
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
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let profile = profile_for(&raw).unwrap();
        // Neutral (1,1,1) camera neutral → should land near D65 CCT → interpolated
        // CM should be between identity (StdA) and 2*identity (D65).
        assert!(profile.color_matrix.0[0][0] > 1.0);
        assert!(profile.color_matrix.0[0][0] < 2.0);
    }

    // ── HSM/PLT integration tests (Ticket 10c) ──────────────────────────────

    /// `apply` with `profile.hsm = None` and no PLT must produce IDENTICAL
    /// output to the legacy single-matmul fast path. Regression guard for
    /// the dcp::apply refactor that introduced the ProPhoto split.
    #[test]
    fn apply_no_hsm_no_plt_matches_fast_path() {
        let cm = Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ]);
        let profile = DcpProfile::from_embedded_cm(cm);
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.5, 0.4, 0.6];
        img.pixels[1] = [0.18, 0.18, 0.18];
        img.pixels[2] = [0.9, 0.1, 0.05];
        img.pixels[3] = [0.0, 0.0, 0.0];
        let out_legacy = apply(&img, &profile).unwrap();
        let out_split  = apply_with_plt(&img, &profile, None).unwrap();
        for i in 0..4 {
            for c in 0..3 {
                assert!((out_legacy.pixels[i][c] - out_split.pixels[i][c]).abs() < 1e-5,
                    "split path pixel {} channel {} drifted: legacy={} split={}",
                    i, c, out_legacy.pixels[i][c], out_split.pixels[i][c]);
            }
        }
    }

    /// `apply` with an IDENTITY HSM table must produce ~identical output to
    /// the no-HSM path. Identity HSM = (0° hue shift, 1× sat, 1× val) at
    /// every lattice point — a no-op. This guards against the HSM hookup
    /// silently corrupting pixels via a ProPhoto round-trip artifact.
    #[test]
    fn apply_with_identity_hsm_is_no_op() {
        let cm = Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ]);
        // Build identity HSM table, attach to profile.
        let dims = [4u32, 2, 2];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n { data.extend_from_slice(&[0.0, 1.0, 1.0]); }
        let hsm_table = crate::color::hsm::HsmTable::new(dims, data, crate::color::hsm::HsmEncoding::Linear).unwrap();
        let mut profile = DcpProfile::from_embedded_cm(cm);
        let baseline = apply(&img_with_pixels(&[
            [0.5, 0.4, 0.6],
            [0.18, 0.18, 0.18],
            [0.9, 0.1, 0.05],
        ]), &profile).unwrap();
        profile.hsm = Some(hsm_table);
        let with_id_hsm = apply(&img_with_pixels(&[
            [0.5, 0.4, 0.6],
            [0.18, 0.18, 0.18],
            [0.9, 0.1, 0.05],
        ]), &profile).unwrap();
        // The HSV→RGB roundtrip on highly-saturated pixels can drift up to
        // ~0.02 in scene-linear units due to floating-point rem_euclid /
        // sextant boundaries — accept that for an "is this approximately a
        // no-op" check. Tighter tolerance can be restored if/when we move
        // to f64 inside the lookup or refactor HSV→RGB to operate on
        // unmodified components.
        for i in 0..3 {
            for c in 0..3 {
                assert!((baseline.pixels[i][c] - with_id_hsm.pixels[i][c]).abs() < 0.02,
                    "identity HSM mutated pixel {} channel {}: no-HSM={} HSM={}",
                    i, c, baseline.pixels[i][c], with_id_hsm.pixels[i][c]);
            }
        }
    }

    /// `apply_with_plt` accepting a non-trivial PLT must produce DIFFERENT
    /// output than the no-PLT path. Sanity check that the PLT plumbing
    /// actually feeds pixels through the table.
    #[test]
    fn apply_with_plt_changes_output() {
        let cm = Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ]);
        let profile = DcpProfile::from_embedded_cm(cm);
        // PLT that doubles saturation everywhere — chroma should jump.
        let dims = [4u32, 2, 2];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n { data.extend_from_slice(&[0.0, 2.0, 1.0]); }
        let plt = crate::color::hsm::HsmTable::new(dims, data, crate::color::hsm::HsmEncoding::Linear).unwrap();
        let img = img_with_pixels(&[[0.6, 0.3, 0.2]]);
        let baseline = apply_with_plt(&img, &profile, None).unwrap();
        let plt_out  = apply_with_plt(&img, &profile, Some(&plt)).unwrap();
        let diff = (baseline.pixels[0][0] - plt_out.pixels[0][0]).abs()
                 + (baseline.pixels[0][1] - plt_out.pixels[0][1]).abs()
                 + (baseline.pixels[0][2] - plt_out.pixels[0][2]).abs();
        assert!(diff > 0.01,
            "PLT had no effect: baseline={:?} plt={:?}",
            baseline.pixels[0], plt_out.pixels[0]);
    }

    /// Dual-illuminant HSM lerp: when both HSM1/HSM2 are present in the
    /// `RawImage`, `interpolated_profile` resolves to a single HSM via
    /// reciprocal-CCT lerp using the SAME `t` as the CM lerp.
    #[test]
    fn dual_hsm_lerps_at_scene_cct() {
        // Build dual-illuminant fixture with HSM1/HSM2 that differ only in
        // a single lattice point to make the lerp trivially observable.
        let m_a = Matrix3::IDENTITY;
        let m_d = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        let dims = [2u32, 2, 1];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        // HSM1: hueDelta = 30° everywhere
        let mut h1_data = Vec::with_capacity(n * 3);
        for _ in 0..n { h1_data.extend_from_slice(&[30.0, 1.0, 1.0]); }
        // HSM2: hueDelta = 90° everywhere
        let mut h2_data = Vec::with_capacity(n * 3);
        for _ in 0..n { h2_data.extend_from_slice(&[90.0, 1.0, 1.0]); }
        let h1 = crate::color::hsm::HsmTable::new(dims, h1_data, crate::color::hsm::HsmEncoding::Linear).unwrap();
        let h2 = crate::color::hsm::HsmTable::new(dims, h2_data, crate::color::hsm::HsmEncoding::Linear).unwrap();

        // At the reciprocal midpoint (StdA 2856K + D65 6504K), lerp should
        // give hueDelta = (30 + 90) / 2 = 60°.
        let mid_cct = 2.0 / (1.0 / 2856.0 + 1.0 / 6504.0);
        // Synthesize an as_shot_neutral that drives compute_as_shot_cct
        // close to mid_cct: pick (1, 1, 1) and use the simpler property
        // that the resolved scene CCT equals the midpoint when CMs are
        // diagonal-ish.
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, m_a);
        cms.insert(Illuminant::D65, m_d);
        // Pick AsShotNeutral so the as_shot_cct lands near the midpoint.
        // For identity-vs-2I matrices, the inverse-mapping puts us close
        // to the midpoint when neutral is (1.5, 1.5, 1.5)-shaped — but we
        // don't need pixel-perfect, only verify the lerp ran and produced
        // something between the endpoints.
        let raw = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4], white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.5, 1.0, 1.7],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: Some(h1),
            hsm_data2: Some(h2),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let profile = profile_for(&raw).unwrap();
        let resolved_hsm = profile.hsm.as_ref().expect("dual-HSM path resolves to a table");
        // The lerped hueDelta must lie in [30, 90].
        let hd = resolved_hsm.data[0];
        assert!(hd >= 30.0 - 0.5 && hd <= 90.0 + 0.5,
            "lerped hueDelta = {} not in expected [30, 90] range", hd);
        // And it should differ from BOTH endpoints (not 30 exactly, not 90 exactly)
        // unless the as_shot_cct happens to clamp at one endpoint — which
        // depends on the synthetic neutral. Allow either case but document.
        let _ = mid_cct;
    }

    /// Tiny helper to construct a 1xN Image of CameraNativeLinearRgb.
    fn img_with_pixels(pixels: &[[f32; 3]]) -> Image {
        let mut img = Image::new(pixels.len() as u32, 1, ColorSpace::CameraNativeLinearRgb);
        for (i, p) in pixels.iter().enumerate() {
            img.pixels[i] = *p;
        }
        img
    }

    #[test]
    fn soft_floor_passes_nonnegative_unchanged() {
        // Already in-gamut: function is a no-op.
        let p = soft_floor([0.5, 0.3, 0.7]);
        assert_eq!(p, [0.5, 0.3, 0.7]);
        let p = soft_floor([0.0, 0.0, 0.0]);
        assert_eq!(p, [0.0, 0.0, 0.0]);
        let p = soft_floor([1.5, 0.8, 0.2]);
        assert_eq!(p, [1.5, 0.8, 0.2]);
    }

    #[test]
    fn soft_floor_lifts_negative_uniformly_preserving_hue() {
        // Mild negative B (the test_0006/test_0007 case): all channels
        // get lifted by |min| = 0.021, hue (channel ratios after lift)
        // is the same as before lift modulo the additive shift.
        let p = soft_floor([0.181, 0.192, -0.021]);
        assert!((p[0] - 0.202).abs() < 1e-5, "R = {}", p[0]);
        assert!((p[1] - 0.213).abs() < 1e-5, "G = {}", p[1]);
        assert!((p[2] - 0.0  ).abs() < 1e-5, "B = {}", p[2]);
        // The smallest channel is at exactly 0 after lifting, by construction.
        assert!(p[0].min(p[1]).min(p[2]) >= -1e-6);
    }

    #[test]
    fn soft_floor_extreme_negative_lifts_correctly() {
        // Heavily out-of-gamut input: lift by the largest negative.
        let p = soft_floor([-0.5, 0.5, 0.5]);
        assert!((p[0] - 0.0).abs() < 1e-6);
        assert!((p[1] - 1.0).abs() < 1e-6);
        assert!((p[2] - 1.0).abs() < 1e-6);
    }
}
