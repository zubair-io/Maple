use crate::{
    color::{
        hsm::{self, HsmTable},
        illuminant::Illuminant,
        matrices::{bradford_adapt, m_pro_to_rec2020, M_PRO_TO_XYZ_D50, XYZ_D50},
        profile_tone_curve::ProfileToneCurve,
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
/// Extended DCP profile support (including 3D LookTable and ToneCurve) per issue #1691.
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
    /// DNG ProfileLookTable (3D HSV-indexed lookup table) for camera profile look.
    pub look_table: Option<HsmTable>,
    /// Custom ProfileToneCurve.
    pub tone_curve: Option<ProfileToneCurve>,
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
            cm.inverse()
                .unwrap_or(Matrix3::IDENTITY)
                .mul_vec([1.0, 1.0, 1.0]),
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
            look_table: None,
            tone_curve: None,
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
///
/// **Colorimetry only** (ticket #425, part of #416). The DCP runs CM / FM for
/// chromatic adaptation and (optionally) `profile.hsm` for metameric
/// correction; it does NOT run the Adobe aesthetic layers — ProfileLookTable
/// (PLT) and ProfileToneCurve (PTC) have been removed from the apply path.
///
/// Rationale: PLT and PTC were calibrated to sit *under* Adobe's tone
/// mapping. Maple's view transform is AgX, which has a different rendering
/// intent (scene-referred → display-referred via a sigmoidal compressor
/// across log-encoded luminance, not Adobe's per-channel RGB tone curve).
/// Stacking the Adobe aesthetic layers on top of AgX produces compound
/// hue errors and a per-format inconsistency (PTC was suppressed for bundled
/// profiles but PLT still ran for bundle-miss bodies — same camera, different
/// tone depending on the source format). Dropping both gives one consistent
/// transform per body. ΔE-to-ACR gets worse on purpose: per #416, the CI
/// reference frame is moving from ACR output to ColorChecker colorimetric
/// accuracy.
///
/// HSM is retained because the bundled DCPs (and many vendor DNGs) use it
/// primarily for **metameric color correction** — off-axis colors that the
/// linear ColorMatrix can't reach because the camera's spectral sensitivities
/// differ from the standard observer. HSM is NOT retained as an aesthetic
/// "look" layer; if a profile's HSM is authored as a look-style rotation
/// (rather than metameric error correction), that's a profile-authoring
/// concern, not a pipeline concern. The bundled profile set (`#324` /
/// `profile_loader`) strips PLT and PTC at bundle-build time; HSM stays.
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
/// chain folds into a single matrix multiply per pixel — the fast path.
///
/// `soft_floor` runs at the exit to lift any post-DCP negative channels
/// (out-of-gamut camera colors that fall outside Rec.2020) by the deficit
/// uniformly across R/G/B — hue-preserving. Retained per #425 (the negative
/// lift doesn't introduce an Adobe-rendering-intent dependency; it's a
/// gamut-correctness guard).
pub fn apply_colorimetry(camera: &Image, profile: &DcpProfile) -> crate::Result<Image> {
    apply_with_post_pro(camera, profile)
}

/// Back-compat alias for [`apply_colorimetry`] — older internal callers and
/// tests still call `dcp::apply(&camera, &profile)`. New code should prefer
/// the explicit name.
pub fn apply(camera: &Image, profile: &DcpProfile) -> crate::Result<Image> {
    apply_colorimetry(camera, profile)
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
fn soft_floor(p: [f32; 3]) -> [f32; 3] {
    let min = p[0].min(p[1]).min(p[2]);
    if min >= 0.0 {
        return p;
    }
    let lift = -min;
    [p[0] + lift, p[1] + lift, p[2] + lift]
}

fn apply_with_post_pro(camera: &Image, profile: &DcpProfile) -> crate::Result<Image> {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);

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
    let inv_pro = M_PRO_TO_XYZ_D50
        .inverse()
        .expect("ProPhoto matrix is invertible");
    let cam_to_pro = match (profile.forward_matrix, profile.wb_already_baked) {
        (Some(fm), true) => inv_pro.mul_mat(&fm),
        _ => {
            // Non-FM / pre-gain-skipped path: invert CM here (lazily — the
            // FM path doesn't need it and skipping the inversion saves a 3x3
            // matrix inverse per image). CM is XYZ→camera per the DNG spec;
            // we want the forward direction.
            //
            // Two reasons to reach here:
            //   1. `forward_matrix` is `None` — no FM in the profile.
            //   2. `wb_already_baked = false` — the 8-bit lossy LinearRaw
            //      escape hatch (see `is_lossy_linearraw`): the converter
            //      baked WB through gamma decode, so AsShotNeutral was NOT
            //      pre-applied by the pipeline's `apply_pre_gain`. Applying
            //      FM here would assume the buffer is WB-divided (FM's
            //      contract per DNG SDK), which it is not — so we Bradford
            //      instead of touching FM.
            let cam_to_xyz = profile.color_matrix.inverse().ok_or_else(|| {
                crate::Error::Dcp("ColorMatrix is singular, cannot invert to camera→XYZ".into())
            })?;
            let adapt = bradford_adapt(profile.scene_white_xyz, XYZ_D50);
            inv_pro.mul_mat(&adapt).mul_mat(&cam_to_xyz)
        }
    };

    if profile.hsm.is_some() || profile.look_table.is_some() {
        // Slow path: project to ProPhoto D50, run HSM (metameric correction)
        // and LookTable (aesthetic look), then project to Rec.2020 D65.
        //
        // NOTE: ProfileToneCurve (PTC) is intentionally NOT applied here.
        // Under ticket #425 (part of #416), PTC is a no-op in the colorimetry-
        // only DCP path on ALL profile sources. PTC was calibrated to sit under
        // Adobe's tone mapping; Maple's view transform is AgX, so applying PTC
        // on top of AgX produces compound hue errors. AgX supplies the canonical
        // tone mapping. See the `apply_colorimetry` doc-comment for the full
        // rationale and `grey_dcp_phase1::profile_tone_curve_is_noop_under_colorimetry_only`
        // for the test that pins this contract.
        let mut pro = Image::new(
            camera.width,
            camera.height,
            ColorSpace::CameraNativeLinearRgb,
        );
        pro.pixels
            .par_iter_mut()
            .zip(camera.pixels.par_iter())
            .for_each(|(o, p)| {
                *o = cam_to_pro.mul_vec(*p);
            });
        if let Some(table) = profile.hsm.as_ref() {
            hsm::apply(&mut pro, table);
        }
        if let Some(table) = profile.look_table.as_ref() {
            apply_look_table(&mut pro, table);
        }
        let exit = m_pro_to_rec2020();
        let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
        out.pixels
            .par_iter_mut()
            .zip(pro.pixels.par_iter())
            .for_each(|(o, p)| {
                *o = soft_floor(exit.mul_vec(*p));
            });
        return Ok(out);
    }

    // Fast path: no HSM. Fold cam_to_pro and exit into one matrix.
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&cam_to_pro);
    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    out.pixels
        .par_iter_mut()
        .zip(camera.pixels.par_iter())
        .for_each(|(o, p)| {
            *o = soft_floor(m.mul_vec(*p));
        });
    Ok(out)
}

// ── Dual-illuminant reciprocal-CCT interpolation ─────────────────────────────

/// Build a color-temperature-specific profile by interpolating between two
/// illuminants' calibration matrices. Reciprocal-CCT lerp per spec § 3.4.
fn interpolate_cm(m1: Matrix3, cct1: f32, m2: Matrix3, cct2: f32, cct_target: f32) -> Matrix3 {
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
pub(crate) fn compute_as_shot_cct(
    wb_neutral: [f32; 3],
    m_cold: Matrix3,
    cct_cold: f32,
    m_warm: Matrix3,
    cct_warm: f32,
) -> f32 {
    let mut cct = (cct_cold + cct_warm) * 0.5; // initial guess
    let mut prev_cct = 0.0;
    for _ in 0..15 {
        if (cct - prev_cct).abs() < 1.0 {
            break;
        }
        prev_cct = cct;
        let cm = interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, cct);
        let cm_inv = match cm.inverse() {
            Some(inv) => inv,
            None => return cct, // degenerate; return current guess
        };
        let xyz = cm_inv.mul_vec(wb_neutral);
        let sum = xyz[0] + xyz[1] + xyz[2];
        if sum < 1e-6 {
            return cct;
        }
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
    m_cold: Matrix3,
    illum_cold: Illuminant,
    m_warm: Matrix3,
    illum_warm: Illuminant,
    wb_neutral: [f32; 3],
    wb_already_baked: bool,
    hsm_cold: Option<&HsmTable>,
    hsm_warm: Option<&HsmTable>,
    fm_cold: Option<Matrix3>,
    fm_warm: Option<Matrix3>,
    look_table: Option<HsmTable>,
    tone_curve: Option<ProfileToneCurve>,
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
        (Some(fc), None) => Some(fc),
        (None, Some(fw)) => Some(fw),
        (None, None) => None,
    };
    // Historical no-pre-gain branch: this path is exercised when WB pre-gain
    // was skipped upstream (currently only the 8-bit lossy LinearRaw
    // `wb_already_baked = true` route — see develop.rs). The non-LinearRaw
    // path pre-gains by AsShotNeutral so a neutral patch enters inv(CM) as
    // (1, 1, 1); without pre-gain, a neutral patch enters inv(CM) as
    // AsShotNeutral.
    // In the no-pre-gain world, a neutral scene patch enters inv(CM) as
    // AsShotNeutral, so the self-consistent Bradford source is
    // `inv(CM_interp) * AsShotNeutral`, normalized to Y=1. For LinearRaw
    // sources (wb_already_baked = true) the converter pre-applied WB, so a
    // neutral patch enters inv(CM) as (1, 1, 1) instead.
    let neutral_for_white = if wb_already_baked {
        [1.0, 1.0, 1.0]
    } else {
        wb_neutral
    };
    let scene_white_xyz = cm
        .inverse()
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
        look_table,
        tone_curve,
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
    cct_cold: f32,
    cct_warm: f32,
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
/// DNG's `ProfileToneCurve` (suppressed for `BundleConfident`, kept
/// otherwise) without re-doing the bundled-profile lookup. See thread
/// `PRRT_kwDOSK_I1M6EOuzz` on PR #330 for the motivation — eliminates
/// a redundant HashMap probe + env var read on every full-frame and
/// tile render.
///
/// Per ticket #460 (4-tier resolver, salvage from #402), `ProfileSource`
/// distinguishes four cases in priority order:
///
///   1. [`EmbeddedFull`] — DNG ships CM + FM + (HSM1 | HSM2). The vendor's
///      own complete calibration; beats the bundle.
///   2. [`BundleConfident`] — byte-exact UCM (or alias) hit in
///      `profiles.bin`. The canonical externally-calibrated profile.
///   3. [`EmbeddedCmOnly`] — DNG ships CM (with or without FM) but no HSM.
///      Partial calibration; loses to the bundle when both are available.
///   4. [`RawlerFallback`] — neither the bundle nor the source DNG carry a
///      usable matrix. Synthetic D65 → Rec.2020 fallback that keeps the
///      pipeline rendering with bounded error — never identity.
///
/// `EmbeddedFull` requires CM + FM + at least one HSM table: this is the
/// shape a real camera-vendor DCP ships (e.g. an Adobe-emitted full DNG
/// from a Hasselblad / DJI body). When that triad is present the embedded
/// profile is internally consistent (FM was calibrated against this exact
/// CM, HSM tuned to this exact FM), and using it whole is strictly better
/// than splicing in the bundle's externally-derived matrices. Anything
/// short of the triad — CM + FM without HSM, CM only — lands at
/// `EmbeddedCmOnly`, which loses to the bundle.
///
/// The `Generic` variant of the previous (#424) three-tier enum has been
/// renamed to `RawlerFallback` for accuracy — rawler always decodes
/// *some* body when given a RAW we can read, so the diagnostic "rawler
/// fell back" framing matches the failure case more directly than the
/// implementation-detail "synthetic D65→Rec.2020" framing. The matrix
/// payload (`M_XYZ_D65_TO_REC2020`) is unchanged from the #424 `Generic`
/// path; per #345's source-mixing rationale, surfacing rawler's
/// substituted CM regresses test_0004 (7.24 → 8.86 ΔE) so we keep the
/// synthetic CM instead.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ProfileSource {
    /// Source DNG ships CM + FM + (HSM1 | HSM2). The vendor's own complete
    /// profile, used whole — beats the bundle's externally-derived
    /// matrices because the embedded triad is internally consistent
    /// (FM calibrated against this exact CM, HSM tuned to this exact FM).
    ///
    /// PTC/PLT contract: the source's PTC/PLT flow through unchanged.
    /// They were authored against the same embedded matrices we're using.
    EmbeddedFull {
        /// Calibration illuminant the embedded matrix was authored under.
        /// Dual-illuminant DNGs report the closer-CCT side after CCT lerp.
        illuminant: Illuminant,
    },
    /// Byte-exact UCM (or alias) hit in Maple's bundled profile table
    /// (`crate::color::profile_loader::lookup_profile`). The canonical
    /// color source: 1,403+ externally-calibrated profiles, PTC/PLT
    /// stripped at the bundle layer (AgX handles tone).
    ///
    /// PTC/PLT contract: the develop chain DROPS the source DNG's PTC
    /// when this variant is in play — that tag was calibrated against
    /// the vendor's own matrices, not the externally-calibrated
    /// substitute. PLT stays (it's the look table). See
    /// `pipeline::develop` comments for the per-call-site contract.
    BundleConfident,
    /// Synthesised from the embedded DNG calibration matrices that
    /// `rawler` decoded out of the source file
    /// (`ColorMatrix1`/`ColorMatrix2` + optional `ForwardMatrix1`/2),
    /// when no `ProfileHueSatMapData1`/`Data2` was present. Used when
    /// the bundle has no entry for this body but the source shipped a
    /// partial calibration. The carried [`Illuminant`] is the
    /// calibration illuminant the profile was authored against — for
    /// dual-illuminant DNGs it's the one closer to the as-shot CCT,
    /// matching the dispatch already used in [`interpolated_profile`].
    ///
    /// PTC/PLT contract: when the develop chain sees `EmbeddedCmOnly`,
    /// the source DNG's PTC/PLT (if any) flow through unchanged — they
    /// were calibrated against the same vendor matrices we're rendering
    /// with, so dropping them would break the tone calibration.
    EmbeddedCmOnly {
        /// Calibration illuminant the embedded matrix was authored under.
        /// Dual-illuminant DNGs report the closer-CCT side after CCT lerp.
        illuminant: Illuminant,
    },
    /// Last-resort fallback when neither the bundle nor the source DNG
    /// carry a usable calibration matrix (vendor RAW from an uncovered
    /// body, or a malformed DNG). Synthesises a CM of
    /// `M_XYZ_D65_TO_REC2020` (XYZ D65 → Rec.2020) — i.e. "pretend the
    /// sensor has Rec.2020 primaries at D65", which under the DNG
    /// XYZ→camera convention makes camera RGB pass through approximately
    /// unchanged into output Rec.2020. Visibly imperfect, but crucially
    /// **not identity** — a true identity matrix treats camera RGB as XYZ
    /// (1.5–3× too bright with grossly miscalibrated channel ratios).
    /// Coverage gaps that produce `RawlerFallback` are logged once per
    /// UCM via `eprintln!` (see [`profile_for_with_source`]).
    ///
    /// The name reflects the diagnostic stance: rawler decoded *some*
    /// body but we have no calibration for it. The CM payload itself is
    /// synthetic; per #345 we deliberately do NOT surface rawler's
    /// dcraw-lineage substituted matrices (which would regress test_0004
    /// 7.24 → 8.86 ΔE).
    ///
    /// PTC/PLT contract: same as `EmbeddedCmOnly` — the source's PTC/PLT
    /// flow through. The matrix is wrong-but-bounded, not wrong-by-2x,
    /// so suppressing PTC would lose tone calibration without buying
    /// anything.
    RawlerFallback,
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
/// Lookup order under ticket #460 (4-tier resolver, salvage from #402):
///
///   1. **Embedded full profile** — DNG ships CM + FM + (HSM1 | HSM2).
///      The vendor's own complete calibration is internally consistent
///      (FM calibrated against this exact CM, HSM tuned to this exact FM)
///      and **wins over the bundle**. Returns
///      [`ProfileSource::EmbeddedFull`]. Synthesised via
///      [`profile_from_embedded_full`].
///
///   2. **Bundled profile** for this camera's UCM (or a known alias —
///      see [`crate::color::ucm_mapping`]). Returns
///      [`ProfileSource::BundleConfident`]. This is the canonical color
///      source for cameras whose embedded profile is partial: 1,403+
///      externally-calibrated profiles, PTC/PLT stripped (AgX handles
///      tone).
///
///   3. **Embedded CM-only fallback** — DNG ships CM (with or without
///      FM, but without HSM) and the bundle missed. Partial calibration;
///      we use it because it's still the camera vendor's own matrix
///      rather than a synthetic. `decode.rs` § 8 (`cm_in_ifd` gate)
///      only populates `raw.color_matrices` for DNG-shaped sources —
///      vendor RAW formats (.fff/.cr2/.arw/.nef/etc.) leave it empty
///      even though `rawler` internally has dcraw-lineage substitute
///      matrices that historically regressed color quality (#345
///      source-mixing rationale).
///
///      Dual-illuminant DNGs are reciprocal-CCT-lerped through
///      [`interpolated_profile`]; single-illuminant DNGs build a
///      profile via [`single_illuminant_profile`]. Returns
///      [`ProfileSource::EmbeddedCmOnly`]. This is the canonical
///      Darktable-style degrade.
///
///   4. **Rawler fallback** — neither the bundle nor the source DNG
///      carry a usable calibration matrix (vendor RAW from an uncovered
///      body, or a malformed DNG). Synthesises a `ColorMatrix` of
///      `M_XYZ_D65_TO_REC2020`. Returns [`ProfileSource::RawlerFallback`].
///      Logged once per UCM via [`log_coverage_gap_once`].
///
/// **Never identity.** Every variant carries a real (non-identity)
/// matrix. Pre-#424 this function returned an identity ColorMatrix for
/// uncovered bodies (1.5–3× over-bright with badly miscalibrated channel
/// ratios; test_0004 hit ΔE mean ≈ 7.96 before #424).
///
/// **No rawler-substituted-CM path.** Steps 1/3 use ONLY matrices the
/// DNG itself carries (`ColorMatrix1/2` / `ForwardMatrix1/2` /
/// `ProfileHueSatMapData1/2`) — never rawler's dcraw-lineage per-body
/// defaults. The previous (#345) "bundle-canonical or bust" stance only
/// banned rawler's substituted matrices, not the matrices that ship
/// inside the DNG file itself.
pub fn profile_for_with_source(raw: &RawImage) -> crate::Result<(DcpProfile, ProfileSource)> {
    let wb_already_baked = !is_lossy_linearraw(raw);

    // ── 1. Embedded full profile (CM + FM + HSM) ──────────────────────────
    // Camera vendor's own complete calibration; beats the bundle because
    // the embedded triad is internally consistent (FM matched to CM, HSM
    // tuned for FM). This is the new behavior under ticket #460.
    if let Some((profile, illuminant)) = profile_from_embedded_full(raw, wb_already_baked) {
        return Ok((profile, ProfileSource::EmbeddedFull { illuminant }));
    }

    // ── 2. Bundled profile ────────────────────────────────────────────────
    if let Some(bundled) = crate::color::profile_loader::lookup_profile(raw) {
        if let Some(p) = crate::color::profile_loader::to_dcp_profile(bundled, raw) {
            return Ok((p, ProfileSource::BundleConfident));
        }
        // to_dcp_profile only fails when the bundle entry has no CMs at
        // all — never observed in practice across the 1,447-profile set.
        // Fall through to the embedded-CM / rawler-fallback paths for the
        // degenerate case.
    }

    // ── 3. Embedded CM-only fallback ──────────────────────────────────────
    // Reached only when no confident bundled profile matched (§2 wins first):
    // the DNG ships CM (with or without FM) but no HSM, so use the camera's own
    // CM/FM pair — internally consistent with the sensor, and better than the
    // synthetic D65 fallback (§4). Two CMs → interpolated profile. One CM →
    // single-illuminant profile.
    if let Some((profile, illuminant)) = profile_from_embedded_cm_only(raw, wb_already_baked) {
        return Ok((profile, ProfileSource::EmbeddedCmOnly { illuminant }));
    }

    // ── 4. Rawler fallback (synthetic D65 → Rec.2020) ─────────────────────
    // Pretend the sensor has Rec.2020 primaries at D65. The DNG `CM` is
    // XYZ→camera, so we want `inv(CM) = M_REC2020_TO_XYZ_D65` — meaning
    // `CM = M_XYZ_D65_TO_REC2020`. Under `apply`'s non-FM Bradford branch,
    // the chain is `inv_pro × adapt(scene_white_xyz, XYZ_D50) × inv(CM) ×
    // camera_rgb`. With `scene_white_xyz = XYZ_D65` and the CM above, a
    // neutral camera reading lands neutral in Rec.2020 D65. Wrong-but-
    // bounded vs the pre-#424 identity-CM catastrophe (which treated camera
    // RGB as XYZ wholesale).
    //
    // Per #345, we deliberately do NOT surface rawler's dcraw-lineage
    // substituted matrices here even though rawler can decode the body —
    // that path regressed test_0004 7.24 → 8.86 ΔE. The synthetic CM is
    // the safer wrong-but-bounded default.
    log_coverage_gap_once(raw);
    let generic_cm = crate::color::matrices::M_XYZ_D65_TO_REC2020;
    Ok((
        DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: generic_cm,
            forward_matrix: None,
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz: crate::color::matrices::XYZ_D65,
            wb_already_baked,
            hsm: None,
            look_table: None, // PLT wiring to DNG source deferred (#1691 Phase 2)
            tone_curve: raw.profile_tone_curve.clone(),
        },
        ProfileSource::RawlerFallback,
    ))
}

/// Maple's pipeline pre-gains by `AsShotNeutral` upstream of DCP for every
/// path EXCEPT the 8-bit lossy LinearRaw escape hatch
/// (`pipeline::develop::develop_scene_linear_from_raw_with_quality` —
/// gamma-decoded camera RGB whose white_level fits in 8 bits).
/// `wb_already_baked` mirrors that pre-gain decision so DCP's Bradford /
/// FM dispatch picks the right neutral source.
#[inline]
fn is_lossy_linearraw(raw: &RawImage) -> bool {
    matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255
}

/// Build a DcpProfile from whatever calibration matrices the source DNG
/// carries, mirroring Darktable's `src/iop/colorin.c` "degrade to
/// embedded matrix" logic. Returns `Some((profile, calibration_illuminant))`
/// when at least one usable, non-identity `ColorMatrix` is present;
/// `None` otherwise.
///
/// **Identity matrices are filtered out** before dispatch. Real cameras
/// never ship `ColorMatrix1 = I` — only synthetic / placeholder DNGs
/// (see `test_support::synth_dng`) do. Treating a literal-identity
/// embedded CM as a real calibration would violate the ticket-#424
/// "never identity" guarantee, so those bodies degrade to `RawlerFallback`.
///
/// Dual-illuminant (CM1 + CM2 with distinct illuminants) → reciprocal-CCT
/// lerp via [`interpolated_profile`]. The returned `illuminant` is the
/// closer-CCT side, matching the dispatch [`interpolated_profile`]
/// already records on `DcpProfile::illuminant`.
///
/// Single-illuminant (one CM) → [`single_illuminant_profile`].
///
/// This shared helper is called by both [`profile_from_embedded_full`]
/// (gated on FM + HSM presence) and [`profile_from_embedded_cm_only`]
/// (no HSM gate). The math is identical; only the resolver's tier
/// classification differs.
fn profile_from_embedded(
    raw: &RawImage,
    wb_already_baked: bool,
) -> Option<(DcpProfile, Illuminant)> {
    let cms = &raw.color_matrices;
    if cms.is_empty() {
        return None;
    }

    // Pick a deterministic (cold, warm) pair when two illuminants are
    // present. "Cold" / "warm" only matter for the lerp's parameter sign;
    // `interpolate_cm` handles either ordering correctly. The DNG spec's
    // convention is illuminant1 = lower CCT, illuminant2 = higher CCT;
    // we sort by CCT to be robust to non-spec orderings.
    let mut entries: Vec<(Illuminant, Matrix3)> = cms
        .iter()
        .filter(|(_, m)| !is_approx_identity(m))
        .map(|(i, m)| (*i, *m))
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by(|a, b| {
        a.0.cct()
            .partial_cmp(&b.0.cct())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if entries.len() >= 2 && entries[0].0 != entries[1].0 {
        let (il_cold, m_cold) = entries[0];
        let (il_warm, m_warm) = entries[1];
        let fm_cold = raw.forward_matrices.get(&il_cold).copied();
        let fm_warm = raw.forward_matrices.get(&il_warm).copied();
        // HSM tables are keyed by their CalibrationIlluminant (mirrors
        // `forward_matrices`), so the cold/warm pairing follows the same
        // sort-by-CCT decision as the CMs — DNGs that ship
        // `CalibrationIlluminant1` warmer than `CalibrationIlluminant2`
        // still get the correct table per side.
        let hsm_cold = raw.hsm_data.get(&il_cold);
        let hsm_warm = raw.hsm_data.get(&il_warm);
        let profile = interpolated_profile(
            m_cold,
            il_cold,
            m_warm,
            il_warm,
            raw.as_shot_neutral,
            wb_already_baked,
            hsm_cold,
            hsm_warm,
            fm_cold,
            fm_warm,
            None, // PLT wiring to DNG source deferred (#1691 Phase 2)
            raw.profile_tone_curve.clone(),
        );
        let illuminant = profile.illuminant;
        return Some((profile, illuminant));
    }

    // Single-illuminant: prefer the entry we already sorted to the front.
    let (illum, cm) = entries[0];
    let fm = raw.forward_matrices.get(&illum).copied();
    // Prefer the HSM keyed to this CM's illuminant; fall back to any HSM
    // present (some DNGs ship only one HSM alongside a single CM). The
    // fallback picks the lowest-CCT ("coldest") HSM rather than
    // `values().next()` — HashMap iteration order is randomised per run, so
    // taking the first arbitrary value would make the chosen profile (and
    // thus the rendered pixels) non-deterministic when several HSM tables
    // are present but none matches the CM's illuminant. Sorting by CCT
    // mirrors the cold/warm convention used for the CM pair above.
    let hsm = raw.hsm_data.get(&illum).cloned().or_else(|| {
        raw.hsm_data
            .iter()
            .min_by(|a, b| {
                a.0.cct()
                    .partial_cmp(&b.0.cct())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(_, table)| table.clone())
    });
    let profile = single_illuminant_profile(
        cm,
        illum,
        fm,
        hsm,
        raw.as_shot_neutral,
        wb_already_baked,
        None, // PLT wiring to DNG source deferred (#1691 Phase 2)
        raw.profile_tone_curve.clone(),
    );
    Some((profile, illum))
}

/// Build a DcpProfile when the source DNG ships a *complete* embedded
/// profile — CM + FM + (HSM1 | HSM2). This is the
/// [`ProfileSource::EmbeddedFull`] tier: the vendor's own internally-
/// consistent calibration, used whole, beats the bundle.
///
/// The gate is "non-empty `color_matrices` AND non-empty
/// `forward_matrices` AND non-empty `hsm_data`" — AND the synthesised
/// profile actually carries `forward_matrix.is_some()` AND
/// `hsm.is_some()`. The post-synth check defends against an
/// illuminant-key mismatch (e.g. CM keyed by D65, FM keyed by StdA):
/// the non-empty maps pass the input gate, but
/// `profile_from_embedded` keys its lookups by the CMs' illuminants, so
/// a mismatched FM map yields `forward_matrix = None` and a mismatched
/// HSM map yields `hsm = None`. Without the post-synth check, this tier
/// would silently surface a half-baked profile that violates the
/// documented CM + FM + HSM invariant.
///
/// Only one HSM table is required (DNG 1.6 § 6.6.5 allows
/// single-illuminant HSM), so the post-synth gate accepts any HSM the
/// CMs' illuminants matched (including the single-illuminant case
/// `profile_from_embedded` handles).
///
/// Returns `None` if any of the three input gates miss or the
/// post-synth FM/HSM check fails; the caller (the resolver) then falls
/// through to the bundle / cm-only / fallback path.
fn profile_from_embedded_full(
    raw: &RawImage,
    wb_already_baked: bool,
) -> Option<(DcpProfile, Illuminant)> {
    if raw.color_matrices.is_empty() || raw.forward_matrices.is_empty() || raw.hsm_data.is_empty() {
        return None;
    }
    let (profile, illuminant) = profile_from_embedded(raw, wb_already_baked)?;
    // Defend the CM + FM + HSM invariant against illuminant-key
    // mismatches. The input gate is necessary but not sufficient — a
    // non-empty `forward_matrices` whose keys don't include the CMs'
    // illuminants synthesises a profile with `forward_matrix = None`,
    // same for HSM. Falling through to EmbeddedCmOnly / RawlerFallback
    // in that case is the contract.
    if profile.forward_matrix.is_none() || profile.hsm.is_none() {
        return None;
    }
    Some((profile, illuminant))
}

/// Build a DcpProfile from a partial embedded profile (CM, with or
/// without FM, but no HSM — or the FM-also-absent case). This is the
/// [`ProfileSource::EmbeddedCmOnly`] tier: the bundle is the preferred
/// source for these bodies, and we only land here when the bundle
/// missed too.
///
/// The resolver gates `EmbeddedFull` first (CM + FM + HSM all present),
/// but the `EmbeddedFull` synth also rejects illuminant-key mismatches
/// — meaning a DNG with a populated `hsm_data` whose keys don't match
/// the CM pair (or that ships HSM but no FM) still falls through to
/// this tier. To match the documented "no HSM" contract for
/// `EmbeddedCmOnly`, we clear `profile.hsm = None` after delegating
/// to `profile_from_embedded`. This guarantees `EmbeddedCmOnly`
/// profiles never carry an HSM table regardless of what
/// `raw.hsm_data` looked like.
fn profile_from_embedded_cm_only(
    raw: &RawImage,
    wb_already_baked: bool,
) -> Option<(DcpProfile, Illuminant)> {
    let (mut profile, illuminant) = profile_from_embedded(raw, wb_already_baked)?;
    // Enforce the tier's "no HSM" contract — see fn-level doc.
    profile.hsm = None;
    Some((profile, illuminant))
}

/// True when `m` is within `1e-4` per element of the identity matrix.
/// Real camera calibration matrices have at least one off-diagonal entry
/// in the 0.05–0.5 range; an identity CM is a synthetic / placeholder
/// shape, NEVER a real calibration. Filtered out of the embedded-CM
/// pool so the "never identity" guarantee of ticket #424 holds at the
/// fixture-DNG layer as well as the no-matrices layer.
fn is_approx_identity(m: &Matrix3) -> bool {
    const EPS: f32 = 1e-4;
    let id = Matrix3::IDENTITY.0;
    for i in 0..3 {
        for j in 0..3 {
            if (m.0[i][j] - id[i][j]).abs() > EPS {
                return false;
            }
        }
    }
    true
}

/// Synthesise a single-illuminant [`DcpProfile`] from one calibration
/// matrix. Shared by `profile_loader::to_dcp_profile`'s single-illum
/// fallback and `profile_from_embedded`'s single-CM path — same algebra,
/// same Bradford-source-from-scene-white derivation that landed in #345.
pub(crate) fn single_illuminant_profile(
    cm: Matrix3,
    illum: Illuminant,
    forward_matrix: Option<Matrix3>,
    hsm: Option<HsmTable>,
    as_shot_neutral: [f32; 3],
    wb_already_baked: bool,
    look_table: Option<HsmTable>,
    tone_curve: Option<ProfileToneCurve>,
) -> DcpProfile {
    let neutral_for_white: [f32; 3] = if wb_already_baked {
        [1.0, 1.0, 1.0]
    } else {
        as_shot_neutral
    };
    let scene_white_xyz = cm
        .inverse()
        .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
        .unwrap_or(crate::color::matrices::XYZ_D65);
    let scene_cct = compute_scene_cct_single(cm, as_shot_neutral, illum.cct());
    DcpProfile {
        illuminant: illum,
        color_matrix: cm,
        forward_matrix,
        scene_cct,
        scene_white_xyz,
        wb_already_baked,
        hsm,
        look_table,
        tone_curve,
    }
}

/// 8-line McCamy CCT estimate for the single-illuminant path.
/// Takes a camera-matrix and `AsShotNeutral`, projects into xy chromaticity
/// via `inv(cm)`, applies McCamy's cubic. Falls back to the calibration
/// illuminant's CCT when the matrix is singular or sums to ~zero.
fn compute_scene_cct_single(cm: Matrix3, wb_neutral: [f32; 3], fallback: f32) -> f32 {
    let cm_inv = match cm.inverse() {
        Some(inv) => inv,
        None => return fallback,
    };
    let xyz = cm_inv.mul_vec(wb_neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum < 1e-6 {
        return fallback;
    }
    let x = xyz[0] / sum;
    let y = xyz[1] / sum;
    let n = (x - 0.3320) / (0.1858 - y);
    let cct = 437.0 * n.powi(3) + 3601.0 * n.powi(2) + 6861.0 * n + 5517.0;
    cct.clamp(2000.0, 15000.0)
}

/// Log uncovered-camera coverage gaps once per UCM. The pipeline calls
/// `profile_for_with_source` per tile, so a naive `eprintln!` here would
/// flood stderr with hundreds of duplicate lines on every slider tick.
/// `OnceLock<Mutex<HashSet<String>>>` is the same dedup pattern
/// `profile_loader::parser::parse_bundle` uses for duplicate-UCM warnings.
fn log_coverage_gap_once(raw: &RawImage) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = crate::color::profile_loader::camera_key_for(raw);
    let ucm = key.unique_camera_model.clone();
    // Recover the inner HashSet even if a previous holder panicked. The set
    // only tracks "have we already logged for this UCM?" — no integrity
    // invariant rides on it, so a logging path shouldn't crash rendering
    // just because some other panic poisoned the lock.
    let mut guard = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.insert(ucm.clone()) {
        eprintln!(
            "[raw-core] dcp::profile_for: generic D65→Rec.2020 fallback for \
             UCM=\"{}\" make=\"{}\" model=\"{}\" — neither bundled profile \
             nor embedded ColorMatrix available; image will render with \
             approximate color. Track coverage in \
             src/raw-pipeline/raw-core/src/color/profiles/COVERAGE.md.",
            ucm, raw.camera_make, raw.camera_model
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_raw(cms: std::collections::HashMap<Illuminant, Matrix3>) -> RawImage {
        RawImage {
            width: 1,
            height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 1,
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
            hsm_data: std::collections::HashMap::new(),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
        }
    }

    /// Regression for the HSM↔illuminant mapping bug raised on PR #455.
    ///
    /// DNG spec § 6.1 names `CalibrationIlluminant1` as the lower-CCT side,
    /// but real files have been observed listing the warmer illuminant
    /// first. Pre-fix, `profile_from_embedded` pulled HSM tables as
    /// `(hsm_data1, hsm_data2)` while the CM pair was sort-by-CCT — so a
    /// reversed-order DNG silently paired CalibrationIlluminant1's HSM
    /// data with the colder calibration matrix and vice versa.
    ///
    /// Now `raw.hsm_data` is keyed by `CalibrationIlluminant`, mirroring
    /// `forward_matrices`. This test constructs a `RawImage` with the
    /// non-spec ordering and asserts the HSM table keyed to the colder
    /// illuminant ends up in the cold slot of the produced `DcpProfile`.
    #[test]
    fn hsm_pairs_with_illuminant_after_cm_sort() {
        // Two visibly distinguishable HSM tables: dims [1,1,1] → one entry
        // each. The COLD-keyed table carries hueDelta = +10° (acts as a
        // sentinel), the WARM-keyed table carries hueDelta = -20°. If the
        // pre-fix slot-positional pairing leaked through, the cold side of
        // the interpolated profile would carry -20° instead of +10°.
        let cold_table = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![10.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 HSM");
        let warm_table = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![-20.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 HSM");

        // Plausible-shape CMs (don't matter for the HSM check, only that
        // both are non-identity so they survive `is_approx_identity`).
        let cm_for_stda = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let cm_for_d65 = Matrix3([
            [0.7501, -0.1234, -0.0712],
            [-0.3801, 1.2001, 0.1899],
            [-0.0488, 0.1801, 0.6011],
        ]);

        // Build the RawImage with both calibration matrices keyed by
        // illuminant. Note we don't care about positional ordering in the
        // HashMap — the bug is exactly that the old code relied on
        // positional ordering elsewhere.
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, cm_for_stda);
        cms.insert(Illuminant::D65, cm_for_d65);

        let mut hsm_data = std::collections::HashMap::new();
        hsm_data.insert(Illuminant::StdA, cold_table.clone());
        hsm_data.insert(Illuminant::D65, warm_table.clone());

        let raw = RawImage {
            width: 1,
            height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 1,
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
            hsm_data,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
        };

        // Drive the embedded path directly so we don't depend on bundle
        // hits for fixture cameras.
        let (profile, _illum) =
            profile_from_embedded(&raw, true).expect("two CMs + two HSMs should produce a profile");

        // The interpolated profile's `hsm` is a lerp of cold + warm. For
        // any reciprocal-CCT `t ∈ [0,1]`, the result's hueDelta sits
        // between +10 and -20 inclusive; if the pre-fix code leaked
        // through, the lerp endpoints would be swapped and the t=0 / t=1
        // edge cases would carry the wrong sign.
        let hsm = profile.hsm.as_ref().expect("dual HSM should lerp to Some");
        let hue_delta = hsm.data[0];
        assert!(
            (-20.0..=10.0).contains(&hue_delta),
            "lerped hueDelta {hue_delta} must lie between cold (+10) and warm (-20) — \
             if it inverts, hsm_data1/2 was paired positionally instead of by illuminant"
        );

        // Direct verification of the keyed mapping (defends against any
        // future change to how `profile_from_embedded` consumes hsm_data):
        // the cold-side table stored under Illuminant::StdA must match
        // what we inserted there.
        assert_eq!(
            raw.hsm_data.get(&Illuminant::StdA).map(|t| t.data[0]),
            Some(10.0),
            "Illuminant::StdA must key the cold HSM table"
        );
        assert_eq!(
            raw.hsm_data.get(&Illuminant::D65).map(|t| t.data[0]),
            Some(-20.0),
            "Illuminant::D65 must key the warm HSM table"
        );
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
            look_table: None,
            tone_curve: None,
        };
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        for p in &mut img.pixels {
            *p = [0.18, 0.18, 0.18];
        }
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
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
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

    /// Under ticket #460 (4-tier resolver), a RawImage with no bundle hit
    /// AND no embedded matrices falls to the rawler-fallback path
    /// (renamed from `Generic` for diagnostic accuracy). The synthesised
    /// ColorMatrix is `M_XYZ_D65_TO_REC2020` (XYZ D65 → Rec.2020, the DNG
    /// XYZ→camera convention applied to a hypothetical Rec.2020-primaries
    /// sensor at D65) — NOT identity. The pipeline still produces pixels
    /// (visibly imperfect, but bounded vs the pre-#424 identity-CM
    /// catastrophe) and the `RawlerFallback` source tag surfaces in
    /// diagnostics.
    #[test]
    fn profile_for_with_no_matrix_returns_rawler_fallback_non_identity() {
        let raw = make_raw(std::collections::HashMap::new());
        let (profile, source) =
            profile_for_with_source(&raw).expect("rawler fallback should succeed");
        assert_eq!(source, ProfileSource::RawlerFallback);
        assert_ne!(
            profile.color_matrix,
            Matrix3::IDENTITY,
            "RawlerFallback must NOT be identity — that's exactly what #424 forbade"
        );
        // The fallback CM is `M_XYZ_D65_TO_REC2020` per the DNG XYZ→camera
        // convention — a hypothetical Rec.2020-primaries sensor at D65.
        // Under `apply`, a neutral camera reading projects to neutral in
        // Rec.2020 D65.
        let expected = crate::color::matrices::M_XYZ_D65_TO_REC2020;
        for i in 0..3 {
            for j in 0..3 {
                assert!(
                    (profile.color_matrix.0[i][j] - expected.0[i][j]).abs() < 1e-6,
                    "RawlerFallback CM mismatch at [{i}][{j}]: got {} expected {}",
                    profile.color_matrix.0[i][j],
                    expected.0[i][j]
                );
            }
        }
        assert_eq!(profile.illuminant, Illuminant::D65);
        assert!(profile.forward_matrix.is_none());
    }

    /// Identity CMs in `color_matrices` are NOT treated as embedded
    /// calibration — they're a synthetic / placeholder shape (see
    /// `test_support::synth_dng`) that real cameras never ship. The
    /// `profile_from_embedded` helper filters them out so the lookup
    /// degrades to `RawlerFallback` instead, preserving ticket-#424's
    /// "never identity" guarantee even when the DNG file itself
    /// claims an identity calibration.
    #[test]
    fn synthetic_raw_with_identity_embedded_cm_falls_through_to_rawler_fallback() {
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, Matrix3::IDENTITY);
        let raw = make_raw(cms);
        let (profile, source) = profile_for_with_source(&raw)
            .expect("identity-CM raw should fall through to RawlerFallback, not error");
        assert_eq!(
            source,
            ProfileSource::RawlerFallback,
            "identity embedded CM must skip to RawlerFallback, got {:?}",
            source
        );
        // Whatever the fallback uses, it must not be identity.
        assert_ne!(profile.color_matrix, Matrix3::IDENTITY);
    }

    /// Embedded-CM-only path: a synthetic RawImage that carries a single
    /// `ColorMatrix1`, no FM/HSM, and no bundle entry surfaces the
    /// embedded matrix verbatim, tagged [`ProfileSource::EmbeddedCmOnly`].
    /// This is the canonical #424 happy path — the body isn't bundled,
    /// but the source DNG ships its own usable calibration. Under #460
    /// the tier is `EmbeddedCmOnly` (not `EmbeddedFull`) because no HSM
    /// is present.
    #[test]
    fn synthetic_raw_with_embedded_cm_surfaces_embedded_cm_only_profile() {
        // Plausible-shape camera CM (matches one of the dual-illum-test
        // matrices below). Pre-#424 this synthetic raw resolved to identity
        // Fallback; under #424/#460 it surfaces as EmbeddedCmOnly.
        let embedded_cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, embedded_cm);
        let raw = make_raw(cms);
        let (profile, source) = profile_for_with_source(&raw).expect("embedded should succeed");
        assert!(
            matches!(
                source,
                ProfileSource::EmbeddedCmOnly {
                    illuminant: Illuminant::D65
                }
            ),
            "expected EmbeddedCmOnly {{ D65 }}, got {:?}",
            source
        );
        // The CM surfaces verbatim — no identity substitution.
        assert_eq!(profile.color_matrix, embedded_cm);
    }

    /// Embedded-CM-only path with dual illuminants: synthesises a profile
    /// via `interpolated_profile`. The reported `Illuminant` is the
    /// closer-CCT side (matches `interpolated_profile`'s own tagging).
    /// Under #460, dual CMs without HSM → `EmbeddedCmOnly`.
    #[test]
    fn synthetic_raw_with_dual_embedded_cms_interpolates() {
        let cm_a = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let cm_d = Matrix3([
            [0.5000, -0.0500, -0.1100],
            [-0.3500, 1.3100, 0.1900],
            [-0.0300, 0.2100, 0.6200],
        ]);
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, cm_a);
        cms.insert(Illuminant::D65, cm_d);
        let raw = make_raw(cms);
        let (profile, source) =
            profile_for_with_source(&raw).expect("dual embedded should succeed");
        // Neutral as-shot-neutral [1, 1, 1] → scene CCT near D65; the
        // returned illuminant should be the D65 side, and the
        // interpolated CM is between the two endpoints (i.e. NOT identity
        // and NOT exactly cm_a / cm_d).
        match source {
            ProfileSource::EmbeddedCmOnly { illuminant } => {
                assert!(
                    matches!(illuminant, Illuminant::D65 | Illuminant::StdA),
                    "expected closer-CCT illuminant; got {:?}",
                    illuminant
                );
            }
            other => panic!("expected EmbeddedCmOnly, got {:?}", other),
        }
        assert_ne!(profile.color_matrix, Matrix3::IDENTITY);
    }

    /// The Darktable-style degrade-to-embedded path renders a neutral
    /// gray patch closer to neutral than the pre-#424 identity-CM
    /// catastrophe ever did. Concretely: a plausible embedded CM
    /// projects (1, 1, 1) through `apply` into something whose R/G/B
    /// ratios are within a few percent of equal, whereas the identity
    /// CM produces a wildly chromatic output (camera RGB interpreted as
    /// XYZ → Rec.2020 D65).
    ///
    /// This is the synthetic stand-in for the test_0004 numeric
    /// regression — without RAW fixtures in CI, we can't assert a `mean`
    /// drop; we CAN assert that the embedded matrix's neutral handling
    /// is closer to neutral than identity's.
    #[test]
    fn embedded_fallback_renders_more_neutral_than_identity_fallback() {
        let embedded_cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);

        // Render with the embedded profile.
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, embedded_cm);
        let raw = make_raw(cms);
        let (prof_embedded, _) = profile_for_with_source(&raw).unwrap();

        // Hypothetical identity-CM profile (the pre-#424 fallback shape).
        let prof_identity = DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: Matrix3::IDENTITY,
            forward_matrix: None,
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz: crate::color::matrices::XYZ_D65,
            wb_already_baked: prof_embedded.wb_already_baked,
            hsm: None,
            look_table: None,
            tone_curve: None,
        };

        // Run a neutral 0.18 mid-gray camera-RGB patch through both.
        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.18, 0.18, 0.18];

        let out_embedded = apply(&img, &prof_embedded).unwrap().pixels[0];
        let out_identity = apply(&img, &prof_identity).unwrap().pixels[0];

        let chroma = |p: [f32; 3]| {
            let mean = (p[0] + p[1] + p[2]) / 3.0;
            ((p[0] - mean).abs() + (p[1] - mean).abs() + (p[2] - mean).abs()) / mean.max(1e-6)
        };
        let chroma_embedded = chroma(out_embedded);
        let chroma_identity = chroma(out_identity);

        assert!(
            chroma_embedded < chroma_identity,
            "embedded path should be more neutral than identity: embedded chroma = {:.4}, \
             identity chroma = {:.4}",
            chroma_embedded,
            chroma_identity
        );
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
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let cm_d = Matrix3([
            [0.5000, -0.0500, -0.1100],
            [-0.3500, 1.3100, 0.1900],
            [-0.0300, 0.2100, 0.6200],
        ]);

        // Scene at 4500K: Hernández-Andrés polynomial → (x, y) → XYZ (Y=1).
        let cct = 4500.0f32;
        let x = 0.244_063 + 99.11 / cct + 2_967_800.0 / (cct * cct)
            - 4_607_000_000.0 / (cct * cct * cct);
        let y = -3.0 * x * x + 2.870 * x - 0.275;
        let xyz_scene: crate::math::Vec3 = [x / y, 1.0, (1.0 - x - y) / y];

        // Simulate the camera reading of a neutral patch at 4500K.
        let t = (1.0 / cct - 1.0 / 2856.0) / (1.0 / 6504.0 - 1.0 / 2856.0);
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
            cm_a,
            Illuminant::StdA,
            cm_d,
            Illuminant::D65,
            as_shot_neutral,
            /* wb_already_baked */ true,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(profile.wb_already_baked);

        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [1.0, 1.0, 1.0];
        let out = apply(&img, &profile).unwrap();
        let p = out.pixels[0];

        let rg = (p[0] - p[1]).abs();
        let bg = (p[2] - p[1]).abs();
        assert!(
            rg < 0.005 && bg < 0.005,
            "not neutral: RGB = ({:.4}, {:.4}, {:.4}), |R-G|={:.4}, |B-G|={:.4}",
            p[0],
            p[1],
            p[2],
            rg,
            bg
        );
    }

    /// `wb_already_baked` derivation is a property of `cfa` +
    /// `white_level`, independent of which profile-source path runs.
    /// Under #424/#460 a synthetic raw without a UCM AND no embedded matrices
    /// goes through the `RawlerFallback` path, which still carries
    /// `wb_already_baked` derived from the same cfa/white_level rules
    /// as the original linearraw / Bayer dispatch — this regression
    /// test confirms that property survives the never-identity refactor.
    ///
    /// Under #373 (Canon non-Bayer decode fix), high-bit-depth
    /// LinearRgb now passes camera-RGB through unchanged in
    /// `linearize::linearraw_to_camera_rgb`; downstream pre-gain still
    /// runs and `wb_already_baked` stays `true` for that path. The
    /// 8-bit lossy LinearRgb branch (`white_level <= 255`) keeps
    /// `wb_already_baked = false` and the legacy
    /// `inv(CM) · AsShotNeutral` Bradford source — same as before.
    #[test]
    fn generic_profile_wb_already_baked_follows_cfa_and_white_level() {
        let warm_wb: [f32; 3] = [1.65, 1.0, 2.16];

        // 16-bit LinearRgb (white_level > 255): pipeline.rs pre-gains,
        // so wb_already_baked = true.
        let raw_linear = RawImage {
            width: 1,
            height: 1,
            cfa: crate::image::CfaPattern::LinearRgb,
            black_level: [0; 4],
            white_level: 65535,
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
            hsm_data: std::collections::HashMap::new(),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
        };
        let (prof_linear, src_linear) = profile_for_with_source(&raw_linear).unwrap();
        // No embedded matrices on this synthetic raw → RawlerFallback.
        assert_eq!(src_linear, ProfileSource::RawlerFallback);
        assert!(
            prof_linear.wb_already_baked,
            "16-bit LinearRgb must get wb_already_baked=true after Phase 1.2"
        );

        let mut raw_bayer = raw_linear.clone();
        raw_bayer.cfa = crate::image::CfaPattern::Rggb;
        let (prof_bayer, _) = profile_for_with_source(&raw_bayer).unwrap();
        assert!(prof_bayer.wb_already_baked);

        // 8-bit lossy LinearRgb (white_level <= 255): no pre-gain,
        // wb_already_baked stays false.
        let mut raw_lossy = raw_linear.clone();
        raw_lossy.white_level = 255;
        let (prof_lossy, _) = profile_for_with_source(&raw_lossy).unwrap();
        assert!(
            !prof_lossy.wb_already_baked,
            "8-bit lossy LinearRgb must keep wb_already_baked=false"
        );
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
            m_cold,
            Illuminant::StdA,
            m_warm,
            Illuminant::D65,
            /* as_shot_neutral */ [1.0, 1.0, 1.0],
            /* wb_already_baked */ false,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        // Neutral (1,1,1) → scene CCT lands near D65 → interpolated CM
        // sits between identity (StdA) and 2*identity (D65).
        assert!(profile.color_matrix.0[0][0] > 1.0);
        assert!(profile.color_matrix.0[0][0] < 2.0);
    }

    // ── HSM integration tests (#425: colorimetry-only) ──────────────────────

    /// `apply` with `profile.hsm = None` must produce identical output to
    /// the legacy single-matmul fast path. Regression guard for the
    /// fast-path vs slow-path split when HSM presence changes.
    #[test]
    fn apply_no_hsm_matches_fast_path() {
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let profile = DcpProfile::from_embedded_cm(cm);
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.5, 0.4, 0.6];
        img.pixels[1] = [0.18, 0.18, 0.18];
        img.pixels[2] = [0.9, 0.1, 0.05];
        img.pixels[3] = [0.0, 0.0, 0.0];
        let out_a = apply(&img, &profile).unwrap();
        let out_b = apply_colorimetry(&img, &profile).unwrap();
        for i in 0..4 {
            for c in 0..3 {
                assert!(
                    (out_a.pixels[i][c] - out_b.pixels[i][c]).abs() < 1e-5,
                    "alias vs new entry drifted at pixel {} channel {}: apply={} colorimetry={}",
                    i,
                    c,
                    out_a.pixels[i][c],
                    out_b.pixels[i][c]
                );
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
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        // Build identity HSM table, attach to profile.
        let dims = [4u32, 2, 2];
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.extend_from_slice(&[0.0, 1.0, 1.0]);
        }
        let hsm_table =
            crate::color::hsm::HsmTable::new(dims, data, crate::color::hsm::HsmEncoding::Linear)
                .unwrap();
        let mut profile = DcpProfile::from_embedded_cm(cm);
        let baseline = apply(
            &img_with_pixels(&[[0.5, 0.4, 0.6], [0.18, 0.18, 0.18], [0.9, 0.1, 0.05]]),
            &profile,
        )
        .unwrap();
        profile.hsm = Some(hsm_table);
        let with_id_hsm = apply(
            &img_with_pixels(&[[0.5, 0.4, 0.6], [0.18, 0.18, 0.18], [0.9, 0.1, 0.05]]),
            &profile,
        )
        .unwrap();
        // The HSV→RGB roundtrip on highly-saturated pixels can drift up to
        // ~0.02 in scene-linear units due to floating-point rem_euclid /
        // sextant boundaries — accept that for an "is this approximately a
        // no-op" check. Tighter tolerance can be restored if/when we move
        // to f64 inside the lookup or refactor HSV→RGB to operate on
        // unmodified components.
        for i in 0..3 {
            for c in 0..3 {
                assert!(
                    (baseline.pixels[i][c] - with_id_hsm.pixels[i][c]).abs() < 0.02,
                    "identity HSM mutated pixel {} channel {}: no-HSM={} HSM={}",
                    i,
                    c,
                    baseline.pixels[i][c],
                    with_id_hsm.pixels[i][c]
                );
            }
        }
    }

    /// Per-pixel determinism of `apply_colorimetry` (#425).
    ///
    /// Running `apply_colorimetry` twice with the same pixels and the
    /// same profile must produce bit-identical output. This is the
    /// minimum contract for a pure function and a prerequisite for
    /// every higher-level parity property (cross-format, cross-platform
    /// pixel equality, parity-harness reproducibility) the develop
    /// pipeline depends on.
    ///
    /// **What this does NOT check:** the cross-format / PLT-bypass
    /// invariance under #425 — i.e. that toggling `raw.plt` or
    /// `raw.profile_tone_curve` on the input `RawImage` does not change
    /// the rendered output. That property is enforced at the
    /// signature level (this function takes no PLT/PTC arguments, so
    /// it physically cannot read them) and verified at the develop-
    /// pipeline level by
    /// `grey_dcp_phase1::profile_tone_curve_is_noop_under_colorimetry_only`
    /// (PTC case). PLT has no synth-DNG fixture today; the signature-
    /// level guarantee plus the PTC integration test together cover the
    /// invariant the docstring formerly claimed.
    #[test]
    fn apply_colorimetry_is_deterministic() {
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let profile = DcpProfile::from_embedded_cm(cm);
        let img = img_with_pixels(&[[0.6, 0.3, 0.2], [0.18, 0.18, 0.18], [0.05, 0.2, 0.7]]);
        let a = apply_colorimetry(&img, &profile).unwrap();
        let b = apply_colorimetry(&img, &profile).unwrap();
        for i in 0..a.pixels.len() {
            for c in 0..3 {
                assert_eq!(
                    a.pixels[i][c], b.pixels[i][c],
                    "apply_colorimetry must be deterministic per-pixel \
                     (pixel {} channel {})",
                    i, c
                );
            }
        }
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
        for _ in 0..n {
            h1_data.extend_from_slice(&[30.0, 1.0, 1.0]);
        }
        let mut h2_data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            h2_data.extend_from_slice(&[90.0, 1.0, 1.0]);
        }
        let h1 =
            crate::color::hsm::HsmTable::new(dims, h1_data, crate::color::hsm::HsmEncoding::Linear)
                .unwrap();
        let h2 =
            crate::color::hsm::HsmTable::new(dims, h2_data, crate::color::hsm::HsmEncoding::Linear)
                .unwrap();

        let profile = interpolated_profile(
            m_a,
            Illuminant::StdA,
            m_d,
            Illuminant::D65,
            /* as_shot_neutral */ [1.5, 1.0, 1.7],
            /* wb_already_baked */ false,
            Some(&h1),
            Some(&h2),
            None,
            None,
            None,
            None,
        );
        let resolved_hsm = profile
            .hsm
            .as_ref()
            .expect("dual-HSM path resolves to a table");
        // Lerped hueDelta lies in [30, 90].
        let hd = resolved_hsm.data[0];
        assert!(
            hd >= 30.0 - 0.5 && hd <= 90.0 + 0.5,
            "lerped hueDelta = {} not in expected [30, 90] range",
            hd
        );
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
        assert!((p[2] - 0.0).abs() < 1e-5, "B = {}", p[2]);
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

    /// Canonical #424 regression test: test_0004 (Hasselblad H5D-40 .fff)
    /// is the fixture-set body with no bundled profile coverage. The .fff
    /// file is a Hasselblad-proprietary TIFF-like container that does NOT
    /// carry DNG-spec `ColorMatrix1`/`ColorMatrix2` IFD tags; rawler
    /// internally substitutes its own dcraw-lineage matrices for
    /// debayer/WB but those substitutes regress real-fixture color (this
    /// fixture: 7.24 → 8.86 ΔE if surfaced as a real embedded matrix —
    /// see `decode.rs` § 8 cm_in_ifd gate and the #345 source-mixing
    /// rationale).
    ///
    /// Under #424/#460 this fixture therefore resolves to
    /// [`ProfileSource::RawlerFallback`], NOT any embedded tier. The
    /// crucial invariant the ticket requires is the **non-identity**
    /// guarantee: the synthesised CM must not be `Matrix3::IDENTITY`
    /// (which was the pre-#424 catastrophe — camera RGB treated as XYZ).
    ///
    /// `ignore`d without `--features fixtures`; with the feature a missing
    /// `test-fixtures/raws/test_0004.fff` fails closed (#1082). The
    /// numeric `mean` improvement is measured by
    /// `src/scripts/test_color_pipeline.sh`, not asserted here — unit
    /// tests can't reproduce ACR's perceptual reference.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn test_0004_hasselblad_h5d40_never_returns_identity_matrix() {
        let path = crate::test_support::fixtures::require_raw("test_0004.fff");
        let raw = crate::decode::decode(&path).expect("decode test_0004.fff");
        // Sanity: this body is the uncovered-by-bundle case the ticket
        // names. If it ever gets bundled, this test loses its meaning;
        // pick a different uncovered fixture at that point.
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_none(),
            "test_0004 must remain bundle-uncovered for this regression test \
             to mean what it claims. If it's been added to the bundle, swap \
             in another uncovered fixture."
        );
        // .fff is a vendor RAW with no DNG ColorMatrix tag in the IFD, so
        // `decode.rs` doesn't surface rawler's substituted matrices and the
        // dispatcher falls through to `RawlerFallback`.
        let (profile, source) = profile_for_with_source(&raw).expect("profile_for");
        assert_eq!(
            source,
            ProfileSource::RawlerFallback,
            "test_0004 (.fff with no DNG CM tags) must resolve to RawlerFallback, \
             got {:?}",
            source
        );
        // Crucially: NEVER identity. This is the #424 contract.
        assert_ne!(
            profile.color_matrix,
            Matrix3::IDENTITY,
            "test_0004 must not carry an identity ColorMatrix — that's \
             exactly the catastrophic pre-#424 case the ticket targets."
        );
    }

    // ── Ticket #460: 4-tier ProfileSource regression tests ───────────────────

    /// Helper for the #460 tests: build a `RawImage` whose UCM hits the
    /// bundle (Canon EOS 5D Mark IV is bundled per
    /// `ucm_mapping::already_covered_ucms_have_no_alias`), with caller-
    /// controlled CM / FM / HSM populations so we can dial in the four
    /// resolver tiers.
    fn make_raw_with_ucm(
        ucm: &str,
        cms: std::collections::HashMap<Illuminant, Matrix3>,
        fms: std::collections::HashMap<Illuminant, Matrix3>,
        hsm_data: std::collections::HashMap<Illuminant, crate::color::hsm::HsmTable>,
    ) -> RawImage {
        RawImage {
            width: 1,
            height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Canon".into(),
            camera_model: "EOS 5D Mark IV".into(),
            unique_camera_model: Some(ucm.into()),
            color_matrices: cms,
            forward_matrices: fms,
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data,
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
        }
    }

    /// Tier 1 (new behavior): a DNG carrying CM + FM + HSM resolves to
    /// `EmbeddedFull` even when the same body has a bundled-profile
    /// entry. The vendor's complete embedded profile beats the bundle
    /// because the embedded triad is internally consistent — bundle
    /// matrices for this body were externally derived and don't share
    /// the same FM/HSM calibration. Pre-#460, this case fell to
    /// `Bundled`, silently dropping the embedded FM/HSM.
    #[test]
    fn embedded_full_beats_bundle() {
        // Plausible-shape CM.
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        // Plausible-shape FM (camera→XYZ-D50). Doesn't need to be the
        // actual vendor FM — we just need it non-empty for the tier-1
        // gate.
        let fm = Matrix3([
            [0.5151, 0.1234, 0.0457],
            [0.2412, 0.7320, 0.0268],
            [0.0148, 0.0975, 0.7129],
        ]);
        // Tiny HSM table; only its presence matters for the tier gate.
        let hsm = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![0.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 identity HSM");

        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, cm);
        let mut fms = std::collections::HashMap::new();
        fms.insert(Illuminant::D65, fm);
        let mut hsm_map = std::collections::HashMap::new();
        hsm_map.insert(Illuminant::D65, hsm);

        // UCM hits the bundle. Confirm that prerequisite first — if
        // someone removes the Canon 5D Mark IV bundled profile this
        // test silently becomes meaningless.
        let raw = make_raw_with_ucm("Canon EOS 5D Mark IV", cms, fms, hsm_map);
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_some(),
            "test prerequisite: 'Canon EOS 5D Mark IV' must be bundled. \
             If the bundle entry was removed, swap in any other UCM the \
             bundle still covers."
        );

        let (_profile, source) = profile_for_with_source(&raw).expect("resolver should succeed");
        assert!(
            matches!(
                source,
                ProfileSource::EmbeddedFull {
                    illuminant: Illuminant::D65
                }
            ),
            "CM + FM + HSM in a DNG with a bundled body must resolve to \
             EmbeddedFull, got {:?} — this is the new behavior under #460, \
             where the embedded triad beats the bundle.",
            source
        );
    }

    /// Tier 2 vs Tier 3: a DNG with CM but NO HSM, AND a bundled body,
    /// resolves to `BundleConfident`. The embedded profile is partial,
    /// so the bundle's externally-calibrated matrices win. (FM
    /// presence isn't the focus of this test — the empty
    /// `forward_matrices` here just keeps the fixture minimal.)
    #[test]
    fn embedded_cm_only_loses_to_bundle() {
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, cm);
        // Empty HSM map — that's what disqualifies EmbeddedFull.
        let raw = make_raw_with_ucm(
            "Canon EOS 5D Mark IV",
            cms,
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
        );
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_some(),
            "test prerequisite: 'Canon EOS 5D Mark IV' must be bundled."
        );

        let (_profile, source) = profile_for_with_source(&raw).expect("resolver should succeed");
        assert_eq!(
            source,
            ProfileSource::BundleConfident,
            "CM-only (no HSM) DNG with a bundled body must resolve to \
             BundleConfident — embedded partial profile loses to the \
             externally-calibrated bundle entry. Got {:?}",
            source
        );
    }

    /// Tier 4: a body with no bundled profile and no embedded matrices
    /// (the vendor-RAW case after `decode.rs`'s `cm_in_ifd` gate drops
    /// rawler's substituted matrices) must resolve to `RawlerFallback`.
    /// Crucially, the CM must NEVER be identity — that's #424's
    /// invariant which #460 must preserve.
    #[test]
    fn rawler_fallback_when_no_dcp_and_no_bundle() {
        // UCM that the bundle definitely doesn't cover (Hasselblad H5D-40
        // is the canonical uncovered fixture, but to keep this test
        // independent of fixture availability we use the `make_raw`
        // helper's bare "Test/Test" body which has no bundled profile.).
        let raw = make_raw(std::collections::HashMap::new());
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_none(),
            "test prerequisite: 'Test/Test' must NOT be bundled"
        );
        let (profile, source) = profile_for_with_source(&raw)
            .expect("resolver should succeed even for uncovered bodies");
        assert_eq!(
            source,
            ProfileSource::RawlerFallback,
            "no DCP + no bundle must resolve to RawlerFallback, got {:?}",
            source
        );
        assert_ne!(
            profile.color_matrix,
            Matrix3::IDENTITY,
            "RawlerFallback CM must NEVER be identity — that violates \
             ticket #424's invariant carried forward into #460."
        );
        // The synthetic CM is `M_XYZ_D65_TO_REC2020` per the DNG
        // XYZ→camera convention.
        let expected = crate::color::matrices::M_XYZ_D65_TO_REC2020;
        for i in 0..3 {
            for j in 0..3 {
                assert!((profile.color_matrix.0[i][j] - expected.0[i][j]).abs() < 1e-6);
            }
        }
    }

    /// EmbeddedFull's HSM resolution uses the per-illuminant
    /// `hsm_data` HashMap from #455: dual-illuminant DNGs with
    /// two HSM tables get reciprocal-CCT-lerped, single-illuminant DNGs
    /// (single CM + single HSM keyed by the matching illuminant) get
    /// the table used as-is. This test wires the dual-illuminant case
    /// through the resolver and confirms the lerped HSM lands on the
    /// produced profile (i.e. the lookup composes correctly across the
    /// HSM HashMap fix).
    #[test]
    fn embedded_full_uses_hsm_map_keyed_by_illuminant() {
        // Two HSM tables with distinguishable hueDelta values, keyed by
        // illuminant. The cold table (StdA) carries +30° hue shift, the
        // warm table (D65) carries -60°; if the resolver pairs them with
        // the wrong CMs (positional pre-#455 bug), the lerp would invert.
        let cold_hsm = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![30.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 HSM");
        let warm_hsm = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![-60.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 HSM");

        let cm_stda = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let cm_d65 = Matrix3([
            [0.5000, -0.0500, -0.1100],
            [-0.3500, 1.3100, 0.1900],
            [-0.0300, 0.2100, 0.6200],
        ]);
        let fm_stda = Matrix3([
            [0.4124, 0.3576, 0.1805],
            [0.2126, 0.7152, 0.0722],
            [0.0193, 0.1192, 0.9505],
        ]);
        let fm_d65 = Matrix3([
            [0.5000, 0.3000, 0.2000],
            [0.2500, 0.6500, 0.1000],
            [0.0200, 0.1500, 0.9000],
        ]);

        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::StdA, cm_stda);
        cms.insert(Illuminant::D65, cm_d65);
        let mut fms = std::collections::HashMap::new();
        fms.insert(Illuminant::StdA, fm_stda);
        fms.insert(Illuminant::D65, fm_d65);
        let mut hsm_map = std::collections::HashMap::new();
        hsm_map.insert(Illuminant::StdA, cold_hsm);
        hsm_map.insert(Illuminant::D65, warm_hsm);

        // Use a UCM that does NOT hit the bundle so we test the
        // EmbeddedFull-vs-no-bundle path cleanly (the
        // `embedded_full_beats_bundle` test covers the bundle-hit case).
        let raw = make_raw_with_ucm("Hypothetical Uncovered Body", cms, fms, hsm_map);

        let (profile, source) = profile_for_with_source(&raw).expect("resolver should succeed");
        assert!(
            matches!(source, ProfileSource::EmbeddedFull { .. }),
            "CM + FM + HSM must resolve to EmbeddedFull, got {:?}",
            source
        );
        // Catching the #455 swap regression through the #460 resolver
        // requires a TIGHT assertion on the lerped value, not just a
        // range check. Compute the expected reciprocal-CCT `t` from the
        // scene CCT the profile recorded (same formula as
        // `lerp_hsm_for_cct`), then assert hueDelta ≈ (1-t)*cold + t*warm
        // within 1e-3. If the cold/warm HSM tables were paired to the
        // wrong CMs (the #455 bug), the lerp endpoints would swap and
        // this assertion fails — empirically validated by swapping the
        // hsm_map insertions during development; the test failed with
        // residual ≈ 90.0 (the full +30 ↔ -60 swing) instead of passing.
        let cct_cold = Illuminant::StdA.cct();
        let cct_warm = Illuminant::D65.cct();
        let inv_t1 = 1.0 / cct_cold;
        let inv_t2 = 1.0 / cct_warm;
        let inv_target = 1.0 / profile.scene_cct;
        let t = ((inv_target - inv_t1) / (inv_t2 - inv_t1)).clamp(0.0, 1.0);
        let expected_hue_delta = (1.0 - t) * 30.0 + t * (-60.0);
        let hsm = profile
            .hsm
            .as_ref()
            .expect("EmbeddedFull must carry an HSM table");
        let hue_delta = hsm.data[0];
        assert!(
            (hue_delta - expected_hue_delta).abs() < 1e-3,
            "lerped hueDelta {hue_delta} ≠ expected {expected_hue_delta} \
             (t={t}, scene_cct={}) — if the cold/warm HSM tables were \
             paired to the wrong CMs (#455 swap regression), this would fail",
            profile.scene_cct
        );
    }

    /// EmbeddedFull's "all three maps non-empty" gate isn't sufficient on
    /// its own: a DNG that lists CMs keyed by {D65}, FMs keyed by
    /// {StdA} (key mismatch — non-empty map but no FM for the CM's
    /// illuminant), and any HSM ends up synthesising a profile whose
    /// `forward_matrix` is `None`. That violates the EmbeddedFull
    /// invariant (CM + FM + HSM all present), so the resolver must
    /// fall through to `EmbeddedCmOnly` (or `BundleConfident` if the
    /// body is bundled) instead of returning `EmbeddedFull` with a
    /// half-baked profile.
    ///
    /// Regression test for PR #466 review comment 1.
    #[test]
    fn embedded_full_falls_through_on_fm_illuminant_mismatch() {
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        // FM keyed to an illuminant that doesn't match the CM's key.
        let fm = Matrix3([
            [0.5151, 0.1234, 0.0457],
            [0.2412, 0.7320, 0.0268],
            [0.0148, 0.0975, 0.7129],
        ]);
        let hsm = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![0.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 identity HSM");

        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, cm);
        let mut fms = std::collections::HashMap::new();
        // Mismatch: FM keyed to StdA, CM keyed to D65.
        fms.insert(Illuminant::StdA, fm);
        let mut hsm_map = std::collections::HashMap::new();
        hsm_map.insert(Illuminant::D65, hsm);

        // Use an uncovered UCM so the bundle doesn't shadow the test —
        // we want to observe the EmbeddedFull / EmbeddedCmOnly tier
        // transition directly.
        let raw = make_raw_with_ucm("Hypothetical Uncovered Body", cms, fms, hsm_map);
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_none(),
            "test prerequisite: 'Hypothetical Uncovered Body' must NOT be bundled"
        );

        let (profile, source) = profile_for_with_source(&raw).expect("resolver should succeed");
        assert!(
            !matches!(source, ProfileSource::EmbeddedFull { .. }),
            "FM key mismatch (non-empty FM map but no FM for the CM's \
             illuminant) must NOT resolve to EmbeddedFull — the \
             synthesised profile would have forward_matrix = None, \
             violating the CM+FM+HSM invariant. Got {:?}",
            source
        );
        // Falls through to EmbeddedCmOnly (no bundle hit, single CM
        // remains usable).
        assert!(
            matches!(source, ProfileSource::EmbeddedCmOnly { .. }),
            "expected EmbeddedCmOnly fallback, got {:?}",
            source
        );
        // Sanity: the surfaced profile actually carries the CM.
        assert_eq!(profile.color_matrix, cm);
    }

    /// `EmbeddedCmOnly`'s docs say "no ProfileHueSatMapData… was
    /// present." If a DNG ships CM + HSM but no FM (a partial profile
    /// shape — non-empty `hsm_data`, empty `forward_matrices`), the
    /// resolver lands here. The synthesised profile must NOT carry the
    /// HSM table from `raw.hsm_data`; carrying it would contradict the
    /// tier docs and the resolver's "no HSM" description.
    ///
    /// Regression test for PR #466 review comment 2.
    #[test]
    fn embedded_cm_only_clears_hsm_even_when_raw_carries_one() {
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        // Populated HSM map but empty FM map — disqualifies EmbeddedFull
        // (which gates on non-empty FM), so the resolver routes through
        // EmbeddedCmOnly.
        let hsm = crate::color::hsm::HsmTable::new(
            [1, 1, 1],
            vec![15.0, 1.0, 1.0],
            crate::color::hsm::HsmEncoding::Linear,
        )
        .expect("valid 1x1x1 HSM");

        let mut cms = std::collections::HashMap::new();
        cms.insert(Illuminant::D65, cm);
        let mut hsm_map = std::collections::HashMap::new();
        hsm_map.insert(Illuminant::D65, hsm);

        // Uncovered UCM so EmbeddedCmOnly (not BundleConfident) is the
        // landing tier.
        let raw = make_raw_with_ucm(
            "Hypothetical Uncovered Body",
            cms,
            std::collections::HashMap::new(),
            hsm_map,
        );
        assert!(
            crate::color::profile_loader::lookup_profile(&raw).is_none(),
            "test prerequisite: 'Hypothetical Uncovered Body' must NOT be bundled"
        );

        let (profile, source) = profile_for_with_source(&raw).expect("resolver should succeed");
        assert!(
            matches!(source, ProfileSource::EmbeddedCmOnly { .. }),
            "CM + HSM without FM (and no bundle) must resolve to \
             EmbeddedCmOnly, got {:?}",
            source
        );
        assert!(
            profile.hsm.is_none(),
            "EmbeddedCmOnly profile must NOT carry an HSM table — \
             per the tier docs, 'no ProfileHueSatMapData… was present' \
             defines this tier. Got hsm = {:?}",
            profile.hsm
        );
    }

    #[test]
    fn test_apply_look_table_shifts() {
        let mut table_data = Vec::new();
        for _ in 0..8 {
            table_data.extend_from_slice(&[15.0, 1.1, 1.05]);
        }
        let table = HsmTable::new(
            [2, 2, 2],
            table_data,
            crate::color::hsm::HsmEncoding::Linear,
        )
        .unwrap();

        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.8, 0.4, 0.2];

        let (h_orig, s_orig, v_orig) = rgb_to_hsv([0.8, 0.4, 0.2]);

        apply_look_table(&mut img, &table);

        let p_new = img.pixels[0];
        let (h_new, s_new, v_new) = rgb_to_hsv(p_new);

        let expected_h = (h_orig + 15.0).rem_euclid(360.0);
        let expected_s = (s_orig * 1.1).clamp(0.0, 1.0);
        let expected_v = v_orig * 1.05;

        assert!((h_new - expected_h).abs() < 1.0e-3);
        assert!((s_new - expected_s).abs() < 1.0e-3);
        assert!((v_new - expected_v).abs() < 1.0e-3);
    }

    /// PR #1709 review finding: the match that dispatches FM vs Bradford was
    /// collapsed to check only `forward_matrix`, dropping the `wb_already_baked`
    /// guard. For 8-bit lossy LinearRaw DNGs (`wb_already_baked = false`) the
    /// pipeline does NOT pre-divide by AsShotNeutral, so the FM contract (FM
    /// expects a WB-divided buffer) is violated. The fix restores the two-arm
    /// match `(Some(fm), true) => FM path, _ => Bradford path`.
    ///
    /// This test constructs a profile with `forward_matrix = Some(...)` but
    /// `wb_already_baked = false` and asserts that the Bradford path runs —
    /// i.e. the output matches what we get when `forward_matrix = None`
    /// (which unambiguously takes Bradford) and differs from what we get when
    /// `wb_already_baked = true` (which would run the FM path).
    #[test]
    fn wb_not_baked_takes_bradford_even_when_forward_matrix_present() {
        // Plausible camera matrix: XYZ → camera at D65.
        let cm = Matrix3([
            [0.7501, -0.1234, -0.0712],
            [-0.3801, 1.2001, 0.1899],
            [-0.0488, 0.1801, 0.6011],
        ]);
        // Plausible forward matrix: WB-divided camera RGB → XYZ-D50.
        let fm = Matrix3([
            [0.5309, 0.2555, 0.1711],
            [0.2034, 0.7981, -0.0015],
            [0.0149, -0.0710, 0.7736],
        ]);
        // Common scene white derived from inv(CM) * [1,1,1] (identity ASN).
        let scene_white_xyz = crate::color::matrices::XYZ_D65;

        // Profile A: wb_already_baked=false + FM present → must take Bradford.
        let profile_wb_false = DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: cm,
            forward_matrix: Some(fm),
            scene_cct: Illuminant::D65.cct(),
            scene_white_xyz,
            wb_already_baked: false,
            hsm: None,
            look_table: None,
            tone_curve: None,
        };
        // Profile B: wb_already_baked=true + FM present → takes FM path.
        let profile_wb_true = DcpProfile {
            wb_already_baked: true,
            ..profile_wb_false.clone()
        };
        // Profile C: forward_matrix=None (unambiguous Bradford reference).
        let profile_no_fm = DcpProfile {
            forward_matrix: None,
            wb_already_baked: false,
            ..profile_wb_false.clone()
        };

        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.5, 0.48, 0.52];

        let out_wb_false = apply(&img, &profile_wb_false).expect("wb_false + FM: should succeed");
        let out_wb_true = apply(&img, &profile_wb_true).expect("wb_true + FM: should succeed");
        let out_no_fm = apply(&img, &profile_no_fm).expect("no FM: should succeed");

        // wb_already_baked=false must produce the same result as no-FM (Bradford)
        // and must differ from wb_already_baked=true (FM path).
        for ch in 0..3 {
            assert!(
                (out_wb_false.pixels[0][ch] - out_no_fm.pixels[0][ch]).abs() < 1e-5,
                "ch={ch}: wb_false path ({}) must equal Bradford-only path ({})",
                out_wb_false.pixels[0][ch],
                out_no_fm.pixels[0][ch]
            );
            // FM path and Bradford path must differ — guards against a
            // degenerate case where the matrices happen to produce the same
            // output.
            let fm_vs_bradford_diff = (out_wb_true.pixels[0][ch] - out_no_fm.pixels[0][ch]).abs();
            assert!(
                fm_vs_bradford_diff > 1e-3,
                "ch={ch}: FM path ({}) and Bradford path ({}) must differ \
                 for this test to be meaningful (diff={fm_vs_bradford_diff:.6})",
                out_wb_true.pixels[0][ch],
                out_no_fm.pixels[0][ch]
            );
        }
    }
}

/// Apply the look table shifts using 3D tetrahedral interpolation in ProPhoto D50 space.
/// Same cylindrical HSV shifts as HSM.
pub fn apply_look_table(img: &mut Image, table: &HsmTable) {
    img.pixels.par_iter_mut().for_each(|p| {
        // Soft lift for negative components
        let min_original = p[0].min(p[1]).min(p[2]);
        let lift = if min_original < 0.0 {
            -min_original
        } else {
            0.0
        };
        let mut rgb = [p[0] + lift, p[1] + lift, p[2] + lift];

        // Pre-encode if sRGB (operates on each channel independently)
        if matches!(table.encoding, crate::color::hsm::HsmEncoding::Srgb) {
            rgb[0] = linear_to_srgb_one(rgb[0]);
            rgb[1] = linear_to_srgb_one(rgb[1]);
            rgb[2] = linear_to_srgb_one(rgb[2]);
        }

        // RGB -> HSV
        let (h, s, v) = rgb_to_hsv(rgb);

        // Lookup (hueDelta, satScale, valScale) via 3D tetrahedral interpolation
        let (hd, ss, vs) = lookup_tetrahedral(table, h, s, v);

        // Achromatic singularity blend: smoothly fade shifts to identity near zero saturation.
        let w_chroma = (s / 0.01).clamp(0.0, 1.0);
        let hd = hd * w_chroma;
        let ss = 1.0 + (ss - 1.0) * w_chroma;
        let vs = 1.0 + (vs - 1.0) * w_chroma;

        // Apply shifts
        let mut new_h = h + hd;
        new_h = new_h.rem_euclid(360.0);
        let new_s = (s * ss).clamp(0.0, 1.0);
        let new_v = (v * vs).max(0.0);

        // HSV -> RGB
        let mut out = hsv_to_rgb(new_h, new_s, new_v);

        // Post-decode if sRGB
        if matches!(table.encoding, crate::color::hsm::HsmEncoding::Srgb) {
            out[0] = srgb_to_linear_one(out[0]);
            out[1] = srgb_to_linear_one(out[1]);
            out[2] = srgb_to_linear_one(out[2]);
        }

        // Restore original negative offset
        if lift > 0.0 {
            *p = [out[0] - lift, out[1] - lift, out[2] - lift];
        } else {
            *p = out;
        }
    });
}

#[inline]
fn linear_to_srgb_one(v: f32) -> f32 {
    let v = v.max(0.0);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
fn srgb_to_linear_one(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn rgb_to_hsv(rgb: [f32; 3]) -> (f32, f32, f32) {
    let r = rgb[0];
    let g = rgb[1];
    let b = rgb[2];
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let v = max;

    let s = if max > 0.0 { delta / max } else { 0.0 };

    let h = if s <= 0.0 || delta < 1e-9 {
        0.0
    } else if (max - r).abs() < 1e-9 {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if (max - g).abs() < 1e-9 {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    let h = if h < 0.0 {
        h + 360.0
    } else if h >= 360.0 {
        h - 360.0
    } else {
        h
    };
    (h, s, v)
}

#[inline]
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [f32; 3] {
    if s <= 0.0 {
        return [v, v, v];
    }
    let h = h.rem_euclid(360.0);
    let c = v * s;
    let h6 = h / 60.0;
    let x = c * (1.0 - ((h6 % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if h6 < 1.0 {
        (c, x, 0.0)
    } else if h6 < 2.0 {
        (x, c, 0.0)
    } else if h6 < 3.0 {
        (0.0, c, x)
    } else if h6 < 4.0 {
        (0.0, x, c)
    } else if h6 < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = v - c;
    [r1 + m, g1 + m, b1 + m]
}

fn lookup_tetrahedral(table: &HsmTable, hue: f32, sat: f32, val: f32) -> (f32, f32, f32) {
    let hd = table.dims[0] as i32;
    let sd = table.dims[1] as i32;
    let vd = table.dims[2] as i32;

    let h_pos = (hue / 360.0) * hd as f32;
    let h_lo = h_pos.floor() as i32;
    let h_frac = h_pos - h_lo as f32;
    let h0 = h_lo.rem_euclid(hd);
    let h1 = (h_lo + 1).rem_euclid(hd);

    let s_pos = sat.clamp(0.0, 1.0) * (sd - 1) as f32;
    let s_lo = s_pos.floor() as i32;
    let s_frac = s_pos - s_lo as f32;
    let s0 = s_lo.clamp(0, sd - 1);
    let s1 = (s_lo + 1).clamp(0, sd - 1);

    let (v0, v1, v_frac) = if vd <= 1 {
        (0, 0, 0.0)
    } else {
        let v_pos = val.clamp(0.0, 1.0) * (vd - 1) as f32;
        let v_lo = v_pos.floor() as i32;
        let v_frac = v_pos - v_lo as f32;
        let v0 = v_lo.clamp(0, vd - 1);
        let v1 = (v_lo + 1).clamp(0, vd - 1);
        (v0, v1, v_frac)
    };

    let entry = |h: i32, s: i32, v: i32| -> [f32; 3] {
        let sat_d = table.dims[1] as usize;
        let val_d = table.dims[2] as usize;
        let i = (((h as usize) * sat_d + (s as usize)) * val_d + (v as usize)) * 3;
        [table.data[i], table.data[i + 1], table.data[i + 2]]
    };

    let c000 = entry(h0, s0, v0);
    let c100 = entry(h1, s0, v0);
    let c010 = entry(h0, s1, v0);
    let c110 = entry(h1, s1, v0);
    let c001 = entry(h0, s0, v1);
    let c101 = entry(h1, s0, v1);
    let c011 = entry(h0, s1, v1);
    let c111 = entry(h1, s1, v1);

    let unwrap_hue = |val: f32, ref_val: f32| -> f32 {
        let mut diff = val - ref_val;
        if diff > 180.0 {
            diff -= 360.0;
        }
        if diff < -180.0 {
            diff += 360.0;
        }
        ref_val + diff
    };

    let h000_u = c000[0];
    let h100_u = unwrap_hue(c100[0], h000_u);
    let h010_u = unwrap_hue(c010[0], h000_u);
    let h110_u = unwrap_hue(c110[0], h000_u);
    let h001_u = unwrap_hue(c001[0], h000_u);
    let h101_u = unwrap_hue(c101[0], h000_u);
    let h011_u = unwrap_hue(c011[0], h000_u);
    let h111_u = unwrap_hue(c111[0], h000_u);

    let fx = h_frac;
    let fy = s_frac;
    let fz = v_frac;

    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let (val000, val100, val010, val110, val001, val101, val011, val111) = if c == 0 {
            (
                h000_u, h100_u, h010_u, h110_u, h001_u, h101_u, h011_u, h111_u,
            )
        } else {
            (
                c000[c], c100[c], c010[c], c110[c], c001[c], c101[c], c011[c], c111[c],
            )
        };

        out[c] = if fx >= fy {
            if fy >= fz {
                val000 * (1.0 - fx) + val100 * (fx - fy) + val110 * (fy - fz) + val111 * fz
            } else if fx >= fz {
                val000 * (1.0 - fx) + val100 * (fx - fz) + val101 * (fz - fy) + val111 * fy
            } else {
                val000 * (1.0 - fz) + val001 * (fz - fx) + val101 * (fx - fy) + val111 * fy
            }
        } else {
            if fx >= fz {
                val000 * (1.0 - fy) + val010 * (fy - fx) + val110 * (fx - fz) + val111 * fz
            } else if fy >= fz {
                val000 * (1.0 - fy) + val010 * (fy - fz) + val011 * (fz - fx) + val111 * fx
            } else {
                val000 * (1.0 - fz) + val001 * (fz - fy) + val011 * (fy - fx) + val111 * fx
            }
        };
    }

    let final_hue = out[0].rem_euclid(360.0);
    (final_hue, out[1], out[2])
}
