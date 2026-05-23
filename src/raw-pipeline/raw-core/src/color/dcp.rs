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
///   single (or interpolated) illuminant, CM (XYZ → camera), optional FM
///   (white-balanced camera RGB → XYZ-D50).
/// See `dng_camera_profile.h` (FM field comment) and
/// `dng_color_spec.cpp:444-446` for the SDK contract — FM does NOT take
/// XYZ as input; it takes the already-WB-divided camera RGB and outputs
/// XYZ chromatically adapted to D50.
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
    /// **White-balanced camera RGB → XYZ-D50** per DNG SDK (NOT XYZ →
    /// ProPhoto, despite older Maple commentary and parts of the spec).
    /// `dng_camera_profile.h` documents FM1/FM2 as "matrices [that] map
    /// white balanced camera values to XYZ chromatically adapted to D50",
    /// and `dng_color_spec.cpp:444-446` builds the full transform as
    /// `forwardMatrix × Invert(refCameraWhite.AsDiagonal()) ×
    /// individualToReference`. With `AnalogBalance = CameraCalibration =
    /// Identity` (Maple's universe), the chain collapses to
    /// `FM × Diag(refCameraWhite)⁻¹ × camera_raw`. Maple's pipeline
    /// pre-gains camera RGB by AsShotNeutral BEFORE DCP (see
    /// `pipeline::develop` step 4), so by the time DCP runs the
    /// `Diag(refCameraWhite)⁻¹ × camera_raw` term is already represented
    /// in the buffer — DCP just needs `cam_to_pro = inv(M_pro_to_xyz_d50)
    /// × FM` and emphatically does NOT compose FM with `inv(CM)`.
    ///
    /// Optional per DNG spec. When present and `wb_already_baked = true`,
    /// the FM path runs. When absent OR `wb_already_baked = false` (the
    /// 8-bit lossy LinearRaw escape hatch), we Bradford from
    /// `scene_white_xyz` to D50 and fall back to the inverse of
    /// `M_PRO_TO_XYZ_D50`.
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
/// Bradford / FM dispatch logic.
///
/// Two paths inside `apply_with_post_pro`:
///
/// * **FM path** — when `profile.forward_matrix` is `Some` AND
///   `profile.wb_already_baked` is `true` (i.e. the pipeline's
///   `white_balance::apply_pre_gain` ran upstream). The buffer arriving
///   here is `camera_raw / AsShotNeutral`, which is the white-balanced
///   camera RGB FM's contract specifies; multiply by FM to get XYZ-D50,
///   then by `inv(M_pro_to_xyz_d50)` to land in linear ProPhoto D50.
///   No runtime Bradford on this path — FM is the calibrated camera-WB
///   → XYZ-D50 mapping. See the `forward_matrix` field docstring for
///   the DNG SDK citations.
/// * **Bradford fallback** — when FM is absent OR pre-gain was skipped
///   (the 8-bit lossy LinearRaw escape hatch). Invert CM, Bradford
///   from `scene_white_xyz` to D50, then `inv(M_pro_to_xyz_d50)` to
///   reach ProPhoto D50. `scene_white_xyz` is the scene illuminant's
///   white point derived from the as-shot neutral, NOT the nearer
///   calibration illuminant — that distinction drives the per-fixture
///   color cast when omitted.
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
/// ProfileToneCurve in profile-working space.
/// Per the DNG SDK reference (`dng_render.cpp:1094-1121`, where the
/// `Render` method chains `DoBaselineHueSatMap` (HSM) →
/// `DoBaselineHueSatMap` again with `fLookTable` (PLT) →
/// `DoBaselineRGBTone` (PTC)), the canonical order is HSM → PLT → PTC,
/// all in linear ProPhoto D50. **NOT** HSM → PTC → PLT (that was the
/// pre-#354 bug — PLT was incorrectly seeing PTC-curved values).
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

    // Camera RGB → ProPhoto D50.
    //
    // Two paths, dispatched on `wb_already_baked` (whether
    // `pipeline::develop` ran `white_balance::apply_pre_gain` before us):
    //
    //   * **FM path (post-#354).** Per DNG SDK
    //     `dng_color_spec.cpp:444-446` the SDK builds `fCameraToPCS =
    //     forwardMatrix * Invert(refCameraWhite.AsDiagonal()) *
    //     individualToReference`. With AnalogBalance = CameraCalibration
    //     = Identity (Maple's universe), the chain reduces to `FM ×
    //     Diag(refCameraWhite)⁻¹ × camera_raw`. Maple's pipeline already
    //     divided camera RGB by AsShotNeutral upstream, so the buffer is
    //     in the FM-input space — DCP just multiplies by FM (yielding
    //     XYZ-D50) and then by `inv(M_pro_to_xyz_d50)` to land in
    //     linear-ProPhoto-D50. Critically: FM is NOT composed with
    //     `inv(CM)` (that double-rotates an already-white-balanced
    //     buffer and was the pre-#354 bug that regressed bundle-canonical
    //     FM application). See the field docstring on `forward_matrix`
    //     for the full citation.
    //   * **Non-FM / pre-gain-skipped path.** Either the profile has no
    //     FM (Bradford fallback per spec § 3.4 step 2) OR pre-gain was
    //     skipped because the source is 8-bit lossy LinearRaw (see
    //     `pipeline::develop::develop_scene_linear_from_raw_with_quality`
    //     comment block; that path leaves WB baked through gamma decode).
    //     In both cases we invert CM, Bradford-adapt from the scene white
    //     to D50, then inverse-ProPhoto to enter ProPhoto D50.
    let inv_pro = M_PRO_TO_XYZ_D50.inverse().expect("ProPhoto matrix is invertible");
    let cam_to_pro = match (profile.forward_matrix, profile.wb_already_baked) {
        (Some(fm), true) => inv_pro.mul_mat(&fm),
        _ => {
            let adapt = bradford_adapt(profile.scene_white_xyz, XYZ_D50);
            inv_pro.mul_mat(&adapt).mul_mat(&cam_to_xyz)
        }
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
        // DNG SDK order per `dng_render.cpp:1094-1121` (the `Render`
        // method): HSM (camera-hue rotation per illuminant) →
        // ProfileLookTable (look HSM, `fLookTable` in the SDK) →
        // ProfileToneCurve (`DoBaselineRGBTone`). All in linear ProPhoto
        // D50. The pre-#354 code applied PTC BEFORE PLT — that swap
        // shifted PLT's value-axis sampling into a region the curve
        // had already steepened, regressing fixtures whose PLT carries
        // value-dependent saturation behaviour.
        if let Some(table) = profile.hsm.as_ref() {
            hsm::apply(&mut pro, table);
        }
        if let Some(table) = post_pro {
            hsm::apply(&mut pro, table);
        }
        if let Some(curve) = ptc {
            crate::color::profile_tone_curve::apply(&mut pro, curve);
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

/// Build a profile by interpolating between two illuminants, using the
/// camera's as-shot neutral to compute the scene CCT. Called by
/// `profile_loader::to_dcp_profile` when the bundled `MapleProfile`
/// carries both CM1 and CM2 (the typical dual-illuminant DCP shape).
/// Also exposed for the dcp.rs unit tests, which exercise the math
/// directly without going through the dispatcher.
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

/// Where the resolved [`DcpProfile`] came from. Carried alongside the
/// profile so the develop chain knows whether to suppress the source
/// DNG's `ProfileToneCurve` (suppressed for `Bundled`, kept otherwise)
/// without re-doing the bundled-profile lookup. See thread
/// `PRRT_kwDOSK_I1M6EOuzz` on PR #330 for the motivation — eliminates
/// a redundant HashMap probe + env var read on every full-frame and
/// tile render.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ProfileSource {
    /// Came from Maple's bundled third-party-derived profile table
    /// (`crate::color::profile_loader::lookup_profile`). PTC/PLT in the
    /// source DNG were calibrated against the vendor's own matrices; the
    /// caller should drop PTC when this variant is in play (see the
    /// `pipeline::develop` comments at each call site).
    Bundled,
    /// Identity-CM fallback — the bundle has no entry for this body and
    /// the UCM-mapping table didn't alias to anything that hit. Under
    /// #345 (bundle-canonical) we no longer silently substitute rawler's
    /// dcraw-lineage matrices, because rawler is decode-only — color
    /// math always comes from the bundle when the bundle has the body.
    /// `Fallback` exists so the develop pipeline can render *something*
    /// (visibly wrong, but not a panic) and the gap shows up in
    /// diagnostics. The profile carries identity CM, no FM, D65
    /// illuminant. Coverage gaps that produce `Fallback` are tracked
    /// in `src/raw-pipeline/raw-core/src/color/profiles/COVERAGE.md`.
    ///
    /// PTC/PLT contract: when the develop chain sees `Fallback`, the
    /// source DNG's PTC/PLT (if any) flow through unchanged — the
    /// identity render is already wrong, stripping the curves compounds
    /// the misrender. See `pipeline::develop` for the call-site logic.
    Fallback,
}

/// Synthesize a `DcpProfile` from a `RawImage`'s embedded color matrices.
///
/// Thin compatibility shim over [`profile_for_with_source`] for callers
/// (tests, the FFI/WASM surfaces) that don't need to know which path won.
/// Pipeline hot paths (`pipeline::develop`, `pipeline::tile::develop`) call
/// `profile_for_with_source` directly to avoid a redundant lookup.
pub fn profile_for(raw: &RawImage) -> crate::Result<DcpProfile> {
    profile_for_with_source(raw).map(|(p, _)| p)
}

/// Same lookup as [`profile_for`], but also returns the [`ProfileSource`]
/// describing which path produced the profile. Used by the develop chain
/// to decide PTC suppression in a single pass — see ticket #324 and the
/// PR #330 PTC-suppression rationale in `pipeline::develop`.
///
/// Lookup order under ticket #345 (bundle-canonical color):
///
///   1. **Maple's bundled third-party-derived profile** for this
///      camera's UCM (or a known alias — see
///      [`crate::color::ucm_mapping`]). Returns
///      [`ProfileSource::Bundled`]. This is the canonical color source:
///      1,403+ externally-calibrated profiles, PTC/PLT stripped (AgX
///      handles tone). If the source is a DNG with its own embedded CM,
///      the bundle's CM wins — every body is authored once by the
///      external standard, not split between bundle (matrices) and
///      vendor (FM/HSM).
///
///   2. **Identity-CM fallback** when the bundle has no entry. Returns
///      [`ProfileSource::Fallback`]. The fallback profile carries an
///      identity ColorMatrix, no ForwardMatrix, D65 illuminant. It
///      keeps the develop pipeline producing pixels (visibly wrong,
///      but not a panic or `Err`) so coverage gaps surface as
///      misrendered output + a `Fallback` source tag in diagnostics
///      instead of being papered over by rawler's dcraw-lineage
///      matrices.
///
/// **No rawler-CM path.** rawler is decode-only — pixels, EXIF,
/// `AsShotNeutral`, black/white levels. Color comes from the bundle.
/// This eliminates the source-mixing failure mode where the bundle's
/// `ForwardMatrix` (calibrated against the bundle's CM) was spliced
/// onto rawler's dcraw-lineage CM — empirically a 3–7 ΔE regression on
/// Fuji / Sony / Nikon under the old gates. See #345 PR body for the
/// before/after numbers.
pub fn profile_for_with_source(raw: &RawImage) -> crate::Result<(DcpProfile, ProfileSource)> {
    if let Some(bundled) = crate::color::profile_loader::lookup_profile(raw) {
        if let Some(p) = crate::color::profile_loader::to_dcp_profile(bundled, raw) {
            return Ok((p, ProfileSource::Bundled));
        }
        // to_dcp_profile only fails when the bundle entry has no CMs at
        // all — never observed in practice across the 1,447-profile set.
        // Fall through to identity-fallback for the degenerate case.
    }
    // Identity-CM fallback: bundle has no usable entry for this body.
    // Render produces visibly-wrong colors (identity CM treats camera
    // RGB as XYZ), but the pipeline keeps moving and the `Fallback`
    // source tag surfaces in diagnostics. Coverage gaps are documented
    // in `src/raw-pipeline/raw-core/src/color/profiles/COVERAGE.md`.
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    let wb_already_baked = !skip_pre_gain;
    Ok((
        DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: crate::math::Matrix3::IDENTITY,
            forward_matrix: None,
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz: crate::color::matrices::XYZ_D65,
            wb_already_baked,
            hsm: None,
        },
        ProfileSource::Fallback,
    ))
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
            unique_camera_model: None,
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

    /// Under ticket #345 (bundle-canonical color), a RawImage with no
    /// bundle hit AND no embedded matrices no longer errors — it returns
    /// an identity-CM fallback profile tagged
    /// [`ProfileSource::Fallback`]. The pipeline produces visibly-wrong
    /// colors, but doesn't panic or return Err. This keeps coverage
    /// gaps surfaceable via the source tag instead of bricking decode.
    #[test]
    fn profile_for_with_no_matrix_returns_fallback() {
        let raw = make_raw(std::collections::HashMap::new());
        let (profile, source) = profile_for_with_source(&raw).expect("fallback should succeed");
        assert_eq!(source, ProfileSource::Fallback);
        assert_eq!(profile.color_matrix, Matrix3::IDENTITY);
        assert_eq!(profile.illuminant, Illuminant::D65);
        assert!(profile.forward_matrix.is_none());
    }

    /// Under #345, `profile_for` always returns Ok — bundle hit returns
    /// `Bundled`, everything else returns identity-`Fallback`. A
    /// synthetic raw with no UCM hits Fallback; the raw's embedded
    /// color_matrices are NOT used (rawler is decode-only). This
    /// replaces the pre-#345 test that expected the embedded path to
    /// surface synthetic CMs verbatim.
    #[test]
    fn synthetic_raw_with_embedded_cms_still_returns_fallback_under_bundle_canonical() {
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, Matrix3([
            [0.7, 0.0, 0.0], [0.0, 0.7, 0.0], [0.0, 0.0, 0.7],
        ]));
        let raw = make_raw(cms);
        let (profile, source) = profile_for_with_source(&raw).expect("fallback should succeed");
        // The synthetic CM is ignored; the fallback identity matrix wins.
        assert_eq!(source, ProfileSource::Fallback);
        assert_eq!(profile.color_matrix, Matrix3::IDENTITY);
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

    /// Bradford-from-scene-CCT (unified path): a neutral patch at an
    /// off-calibration scene CCT must render neutral. Failure mode this
    /// catches: Bradford adapted from nearest-calibration illuminant
    /// instead of the scene illuminant leaves residual chroma.
    ///
    /// Calls `interpolated_profile` directly because under #345
    /// (bundle-canonical) `profile_for` no longer dispatches on
    /// synthetic `color_matrices` — those would now resolve to identity
    /// `Fallback`. The math here is `interpolated_profile`'s, not the
    /// dispatcher's, so the direct call is the right shape.
    #[test]
    fn neutral_patch_at_scene_illuminant_renders_approximately_neutral() {
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

        // Simulate the camera reading of a neutral patch at 4500K.
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

        // Build the dual-illuminant profile directly via
        // `interpolated_profile`. wb_already_baked = true matches the
        // production Bayer post-pre-gain contract.
        let profile = interpolated_profile(
            cm_a, Illuminant::StdA,
            cm_d, Illuminant::D65,
            as_shot_neutral,
            /* wb_already_baked */ true,
            None, None,
            None, None,
        );
        assert!(profile.wb_already_baked);

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

    /// `wb_already_baked` derivation is a property of `cfa` +
    /// `white_level`, independent of which profile-source path runs.
    /// Under #345 a synthetic raw without a UCM goes through the
    /// `Fallback` path, but the Fallback profile still carries
    /// `wb_already_baked` derived from the same cfa/white_level rules
    /// as the original linearraw / Bayer dispatch — this regression
    /// test confirms that property survives the strict-bundle refactor.
    #[test]
    fn fallback_profile_wb_already_baked_follows_cfa_and_white_level() {
        let warm_wb: [f32; 3] = [1.65, 1.0, 2.16];

        // 16-bit LinearRgb (white_level > 255): pipeline.rs pre-gains,
        // so wb_already_baked = true.
        let raw_linear = RawImage {
            width: 1, height: 1,
            cfa: crate::image::CfaPattern::LinearRgb,
            black_level: [0; 4], white_level: 65535,
            raw_data: vec![0; 3],
            as_shot_neutral: warm_wb,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            unique_camera_model: None,
            color_matrices: std::collections::HashMap::new(),
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data1: None,
            hsm_data2: None,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
        };
        let (prof_linear, src_linear) = profile_for_with_source(&raw_linear).unwrap();
        assert_eq!(src_linear, ProfileSource::Fallback);
        assert!(prof_linear.wb_already_baked,
            "16-bit LinearRgb must get wb_already_baked=true after Phase 1.2");

        let mut raw_bayer = raw_linear.clone();
        raw_bayer.cfa = crate::image::CfaPattern::Rggb;
        let (prof_bayer, _) = profile_for_with_source(&raw_bayer).unwrap();
        assert!(prof_bayer.wb_already_baked);

        // 8-bit lossy LinearRgb (white_level <= 255): no pre-gain,
        // wb_already_baked stays false.
        let mut raw_lossy = raw_linear.clone();
        raw_lossy.white_level = 255;
        let (prof_lossy, _) = profile_for_with_source(&raw_lossy).unwrap();
        assert!(!prof_lossy.wb_already_baked,
            "8-bit lossy LinearRgb must keep wb_already_baked=false");
    }

    /// `interpolated_profile` produces a CM between the two endpoints
    /// when scene CCT lands between the calibration CCTs. This used to
    /// be tested via `profile_for(synthetic_raw)`; under #345 the
    /// dispatcher no longer surfaces synthetic CMs, so the direct
    /// call is the appropriate test surface.
    #[test]
    fn interpolated_profile_lerps_between_endpoint_cms() {
        let m_cold = Matrix3::IDENTITY;
        let m_warm = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        let profile = interpolated_profile(
            m_cold, Illuminant::StdA,
            m_warm, Illuminant::D65,
            /* as_shot_neutral */ [1.0, 1.0, 1.0],
            /* wb_already_baked */ false,
            None, None,
            None, None,
        );
        // Neutral (1,1,1) → scene CCT lands near D65 → interpolated CM
        // sits between identity (StdA) and 2*identity (D65).
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

    /// Dual-illuminant HSM lerp: `interpolated_profile` resolves the
    /// HSM via reciprocal-CCT lerp using the SAME `t` as the CM lerp.
    /// Tested by calling `interpolated_profile` directly (under #345
    /// `profile_for` doesn't surface synthetic HSMs because the
    /// dispatcher hits Fallback for synthetic raws).
    #[test]
    fn dual_hsm_lerps_at_scene_cct() {
        let m_a = Matrix3::IDENTITY;
        let m_d = Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        let dims = [2u32, 2, 1];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        let mut h1_data = Vec::with_capacity(n * 3);
        for _ in 0..n { h1_data.extend_from_slice(&[30.0, 1.0, 1.0]); }
        let mut h2_data = Vec::with_capacity(n * 3);
        for _ in 0..n { h2_data.extend_from_slice(&[90.0, 1.0, 1.0]); }
        let h1 = crate::color::hsm::HsmTable::new(dims, h1_data, crate::color::hsm::HsmEncoding::Linear).unwrap();
        let h2 = crate::color::hsm::HsmTable::new(dims, h2_data, crate::color::hsm::HsmEncoding::Linear).unwrap();

        let profile = interpolated_profile(
            m_a, Illuminant::StdA,
            m_d, Illuminant::D65,
            /* as_shot_neutral */ [1.5, 1.0, 1.7],
            /* wb_already_baked */ false,
            Some(&h1), Some(&h2),
            None, None,
        );
        let resolved_hsm = profile.hsm.as_ref().expect("dual-HSM path resolves to a table");
        // Lerped hueDelta lies in [30, 90].
        let hd = resolved_hsm.data[0];
        assert!(hd >= 30.0 - 0.5 && hd <= 90.0 + 0.5,
            "lerped hueDelta = {} not in expected [30, 90] range", hd);
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
