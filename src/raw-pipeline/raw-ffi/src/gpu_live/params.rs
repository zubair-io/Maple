//! C-params → [`FullChainInputs`] marshalling for the gpu-gated live FFI,
//! split out of `gpu_live.rs` (600-LOC file budget, same pattern as
//! `raw_gpu::live_session::limits`): the `(ptr, len)` readers, the WB-matrix
//! derivation, and the identity fallbacks for absent Auto Profile artifacts.
//! Pure relocation; no behavior change.

use super::MapleGpuLiveParams;
use raw_gpu::{FullChainInputs, InputShape};
use std::borrow::Cow;

/// Read a flat `(ptr, len)` f32 array into an owned `Vec` of `(x, y)` point pairs
/// (the [`raw_gpu::ToneCurveInputs`] point shape). A null pointer or zero len ⇒
/// an empty Vec (the identity curve). `len` MUST be even (pairs).
///
/// # Safety
/// `ptr` must be valid for `len` `f32` reads, or null.
unsafe fn read_points(ptr: *const f32, len: usize) -> Vec<(f32, f32)> {
    if ptr.is_null() || len == 0 {
        return Vec::new();
    }
    let flat = std::slice::from_raw_parts(ptr, len);
    flat.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

/// Map a registry-resolved raster list into raw-gpu's own carrier shape
/// (#3271) — `raw_gpu::GpuMaskRaster` can't be `raw_core::types::MaskRaster`
/// directly; see that type's doc for why (raw-gpu takes raw-core only as a
/// dev-dependency).
fn to_gpu_rasters(
    rasters: Vec<std::sync::Arc<raw_core::types::MaskRaster>>,
) -> Vec<raw_gpu::GpuMaskRaster> {
    rasters
        .into_iter()
        .map(|r| raw_gpu::GpuMaskRaster {
            id: r.id,
            width: r.width,
            height: r.height,
            data: r.data.clone(),
        })
        .collect()
}

/// Read a flat `(ptr, len)` f32 array into an owned `Vec<f32>`. Null/zero ⇒ empty.
///
/// # Safety
/// `ptr` must be valid for `len` `f32` reads, or null.
unsafe fn read_floats(ptr: *const f32, len: usize) -> Vec<f32> {
    if ptr.is_null() || len == 0 {
        return Vec::new();
    }
    std::slice::from_raw_parts(ptr, len).to_vec()
}

/// The three split fields read as a group: ALL THREE exactly `0.0` ⇒ absent
/// (a stale host that predates the fields' append, or a zero-initialized
/// caller, always leaves every one of them at the struct's zero default) ⇒
/// substitute ACR's documented 25/50/75. Otherwise every field passes
/// through UNCHANGED, including a genuine `0.0` in one of the three — `0.0`
/// is an in-range axis position (the documented range is `[0, 100]`), so
/// gating per-field would make it impossible for a live host to ever set
/// `parametric_shadow_split` to exactly 0 (Copilot review on #3219: gating
/// each field independently did exactly that). See the
/// `parametric_{shadow,midtone,highlight}_split` doc comment on
/// [`MapleGpuLiveParams`] for why this trio, unlike most tail fields, can't
/// use `0.0` as its own per-field identity value.
fn parametric_split_or_defaults(shadow: f32, midtone: f32, highlight: f32) -> [f32; 3] {
    if shadow == 0.0 && midtone == 0.0 && highlight == 0.0 {
        [25.0, 50.0, 75.0]
    } else {
        [shadow, midtone, highlight]
    }
}

/// Build the `raw_gpu::FullChainInputs` the live chain consumes from the C params,
/// deriving the WB matrix from temp/tint the same way the CPU chain does. The
/// large immutable profile/film arrays are borrowed for the synchronous render;
/// short editable point-curve arrays are owned. The host keeps all pointers live
/// until the FFI call returns; GPU uploads copy into independently owned buffers.
///
/// # Safety
/// `p` and every non-null `(ptr, len)` it carries must remain valid and immutable
/// for the returned inputs' lifetime (bounded by the synchronous FFI call).
pub(super) unsafe fn inputs_from_params(p: &MapleGpuLiveParams) -> FullChainInputs<'_> {
    use raw_gpu::{CurveMode, ToneCurveInputs};

    let wb_method = match p.wb_method {
        1 => raw_core::types::WbMethod::DiagonalRec2020,
        _ => raw_core::types::WbMethod::Cat16,
    };
    // Compute the WB matrix (#1240 follow-up). When the host supplies a
    // `decoded_temperature` (> 0 — the 0/0 sentinel means "no decoded WB"),
    // build the DELTA `M_net = M_live · M_decoded⁻¹` matching
    // `raw_core::stages::white_balance::apply_delta`. This handles the editor
    // decode-boundary contract: the f32 buffer is at D65 (post-DCP), but
    // Apple's `processSceneLinear` passes `decodedTemp = asShot.temperature`,
    // so the chain's WB step is the live-vs-asShot delta (identity at default
    // slider value, where live == asShot). With `M_live` alone, the GPU
    // canvas baked `wb_cat16(asShot)` into the D65 buffer for every render —
    // a uniform colour cast on any photo whose as-shot CCT was far from D65
    // (e.g. test_0002 at asShot=4522K).
    //
    // When the host does NOT supply decoded WB (0/0 sentinel), preserve the
    // pre-#1240 absolute apply: `M_net = M_live`. This is what legacy callers
    // (and the headless render path) expect — `wb_cat16_matrix(6500, 0)` is
    // NOT exactly identity, so naively forcing `decoded_temp = 6500` and
    // composing with its inverse would silently change the legacy output.
    // (Copilot review on #1262.)
    let use_delta = p.decoded_temperature > 0.0;
    // WB slider frame (#1781): the decode-exported `SliderFrame` data. Only
    // meaningful for RAW input (`input_shape == 0` — a non-RAW buffer has no
    // camera calibration) AND under the delta contract (`use_delta` — the
    // frame math is inherently anchor-relative; legacy absolute callers never
    // supply a frame). A zero-filled tail reads `scene_cct == 0` ⇒ absent ⇒
    // every branch below is byte-for-byte the pre-#1781 computation.
    let wb_frame = crate::wb_frame_flat::wb_frame_from_flat(&crate::wb_frame_flat::WbFrameFlat {
        m_cold: &p.wb_frame_m_cold,
        cct_cold: p.wb_frame_cct_cold,
        m_warm: &p.wb_frame_m_warm,
        cct_warm: p.wb_frame_cct_warm,
        scene_cct: if p.input_shape == 0 {
            p.wb_frame_scene_cct
        } else {
            0.0
        },
        as_shot_tint: p.wb_frame_as_shot_tint,
        render_cm: &p.wb_frame_render_cm,
        render_forward_matrix: &p.wb_frame_render_forward_matrix,
        render_scene_white_xyz: &p.wb_frame_render_scene_white_xyz,
        render_wb_already_baked: p.wb_frame_render_wb_already_baked,
        render_cm_cold: &p.wb_frame_render_cm_cold,
        render_cct_cold: p.wb_frame_render_cct_cold,
        render_cm_warm: &p.wb_frame_render_cm_warm,
        render_cct_warm: p.wb_frame_render_cct_warm,
        render_fm_cold: &p.wb_frame_render_fm_cold,
        render_fm_warm: &p.wb_frame_render_fm_warm,
    });
    let frame_delta_engaged = use_delta && wb_frame.is_present();
    let wb_matrix = if frame_delta_engaged {
        // Frame-anchored delta: `C_f · diag(g(live)/g(decoded)) · C_f⁻¹` —
        // the same `wb_camera` gain math the CPU develop interprets the
        // sliders with, conjugated into Rec.2020 (see
        // `wb_camera::SliderFrameExport::rec2020_delta_matrix`). Exact
        // identity at `live == decoded`. `wb_method` is irrelevant here —
        // the frame defines the slider scale.
        wb_frame
            .rec2020_delta_matrix(
                (p.temperature, p.tint),
                (p.decoded_temperature, p.decoded_tint),
            )
            .0
    } else {
        match wb_method {
            raw_core::types::WbMethod::Cat16 => {
                let m_live =
                    raw_core::stages::white_balance::wb_cat16_matrix(p.temperature, p.tint);
                if use_delta {
                    let m_decoded = raw_core::stages::white_balance::wb_cat16_matrix(
                        p.decoded_temperature,
                        p.decoded_tint,
                    );
                    let m_decoded_inv = m_decoded
                        .inverse()
                        .expect("CAT16 user-WB matrix is non-singular for valid (T, tint)");
                    m_live.mul_mat(&m_decoded_inv).0
                } else {
                    m_live.0
                }
            }
            raw_core::types::WbMethod::DiagonalRec2020 => {
                let g_live = raw_core::stages::white_balance::wb_gains(p.temperature, p.tint);
                if use_delta {
                    let g_decoded = raw_core::stages::white_balance::wb_gains(
                        p.decoded_temperature,
                        p.decoded_tint,
                    );
                    let r = [
                        g_live[0] / g_decoded[0].max(1e-6),
                        g_live[1] / g_decoded[1].max(1e-6),
                        g_live[2] / g_decoded[2].max(1e-6),
                    ];
                    [[r[0], 0.0, 0.0], [0.0, r[1], 0.0], [0.0, 0.0, r[2]]]
                } else {
                    [
                        [g_live[0], 0.0, 0.0],
                        [0.0, g_live[1], 0.0],
                        [0.0, 0.0, g_live[2]],
                    ]
                }
            }
        }
    };
    // Live-builder WB gate values (#1781). `build_live_chain` gates the WB
    // pass on `wb_is_noop(wb_temperature, wb_tint)` — the ABSOLUTE 6500/0
    // short-circuit predicate. Under the frame-anchored DELTA contract the
    // correct skip condition is `live == decoded` (the matrix is exact
    // identity there), so synthesize gate values that make the absolute
    // predicate test exactly that: `6500 + (live − decoded)` Kelvin and
    // `live − decoded` tint. Legacy paths (no frame) pass the raw live
    // values through unchanged — bit-identical gating to pre-#1781.
    let (gate_temperature, gate_tint) = if frame_delta_engaged {
        (
            6500.0 + (p.temperature - p.decoded_temperature),
            p.tint - p.decoded_tint,
        )
    } else {
        (p.temperature, p.tint)
    };

    let capture_sharpening = if p.capture_sharpening_enabled != 0 {
        Some(raw_gpu::CaptureSharpeningParams {
            sigma: p.capture_sharpening_sigma,
            iterations: p.capture_sharpening_iterations,
            highlight_threshold: p.capture_sharpening_highlight_threshold,
            strength: p.capture_sharpening_strength,
            // noise_floor is not yet exposed in MapleAdjustmentParams; use the
            // same default (3e-4) that raw-core's CaptureSharpeningParams::default()
            // applies, so the GPU path matches the CPU reference.
            noise_floor: raw_gpu::CaptureSharpeningParams::default().noise_floor,
        })
    } else {
        None
    };

    // Film look (epic #2683, Task 8) — computed once, ahead of the struct
    // literal, so a mismatched host buffer is validated/logged exactly once.
    let (film_lut_size, film_lut_data) = film_lut_or_off(p);
    let (residual_lut_size, residual_lut_data) = residual_or_identity(p);

    // Local-adjustment flat wire + its bitmap rasters (#3271) — read together
    // so `local_adjustments` and `mask_rasters` below always describe the
    // SAME wire snapshot; see `crate::mask_registry::layers_and_rasters_from_flat`.
    let local_flat = read_floats(p.local_adjustments_ptr, p.local_adjustments_len);
    let (_, mask_rasters) = crate::mask_registry::layers_and_rasters_from_flat(&local_flat);

    FullChainInputs {
        wb_matrix,
        wb_temperature: gate_temperature,
        wb_tint: gate_tint,
        tone: [
            p.exposure,
            p.brightness,
            p.highlights,
            p.shadows,
            p.whites,
            p.blacks,
        ],
        tone_curves: ToneCurveInputs {
            parametric: [
                p.parametric_shadows,
                p.parametric_darks,
                p.parametric_lights,
                p.parametric_highlights,
            ],
            parametric_split: parametric_split_or_defaults(
                p.parametric_shadow_split,
                p.parametric_midtone_split,
                p.parametric_highlight_split,
            ),
            luma: read_points(p.tone_curve_luma_ptr, p.tone_curve_luma_len),
            red: read_points(p.tone_curve_red_ptr, p.tone_curve_red_len),
            green: read_points(p.tone_curve_green_ptr, p.tone_curve_green_len),
            blue: read_points(p.tone_curve_blue_ptr, p.tone_curve_blue_len),
            mode: match p.tone_curve_mode {
                1 => CurveMode::RatioPreserving,
                _ => CurveMode::PerChannel,
            },
        },
        vibrance: p.vibrance,
        saturation: p.saturation,
        clarity: p.clarity,
        texture: p.texture,
        dehaze: p.dehaze,
        // Local adjustments (#1698). The wire is already the GPU storage
        // layout, so this is a copy, not a re-pack: `read_floats` returns an
        // owned Vec so the caller's buffer need not outlive the render, and a
        // NULL / zero-length field (every host that has no masks, including
        // one built against a pre-#1698 header) yields an empty stack, which
        // omits the pass entirely.
        local_adjustments: local_flat,
        // Every `KIND_BITMAP` record's raster, resolved from the SAME flat
        // wire against the process-wide registry (#3271) — computed once,
        // above, and shared with `local_adjustments` so a bitmap record and
        // its raster are always read from an identical snapshot of the wire.
        mask_rasters: to_gpu_rasters(mask_rasters),
        vignette_amount: p.vignette_amount,
        vignette_feather: p.vignette_feather,
        grain_amount: p.grain_amount,
        grain_size: p.grain_size,
        grain_roughness: p.grain_roughness,
        split_tone_shadow_hue: p.split_tone_shadow_hue,
        split_tone_shadow_saturation: p.split_tone_shadow_saturation,
        split_tone_highlight_hue: p.split_tone_highlight_hue,
        split_tone_highlight_saturation: p.split_tone_highlight_saturation,
        split_tone_balance: p.split_tone_balance,
        color_grade_shadow_luminance: p.color_grade_shadow_luminance,
        color_grade_midtone_hue: p.color_grade_midtone_hue,
        color_grade_midtone_saturation: p.color_grade_midtone_saturation,
        color_grade_midtone_luminance: p.color_grade_midtone_luminance,
        color_grade_highlight_luminance: p.color_grade_highlight_luminance,
        color_grade_global_hue: p.color_grade_global_hue,
        color_grade_global_saturation: p.color_grade_global_saturation,
        color_grade_global_luminance: p.color_grade_global_luminance,
        // HSL 8-band adjustments (#1112).
        hsl_hue: [
            p.hsl_hue_red,
            p.hsl_hue_orange,
            p.hsl_hue_yellow,
            p.hsl_hue_green,
            p.hsl_hue_aqua,
            p.hsl_hue_blue,
            p.hsl_hue_purple,
            p.hsl_hue_magenta,
        ],
        hsl_sat: [
            p.hsl_sat_red,
            p.hsl_sat_orange,
            p.hsl_sat_yellow,
            p.hsl_sat_green,
            p.hsl_sat_aqua,
            p.hsl_sat_blue,
            p.hsl_sat_purple,
            p.hsl_sat_magenta,
        ],
        hsl_lum: [
            p.hsl_lum_red,
            p.hsl_lum_orange,
            p.hsl_lum_yellow,
            p.hsl_lum_green,
            p.hsl_lum_aqua,
            p.hsl_lum_blue,
            p.hsl_lum_purple,
            p.hsl_lum_magenta,
        ],
        // Black & white mix (#276) — same band order; a stale host leaves
        // `bw_active` 0 = colour, bit-identical to pre-#276 output.
        bw_mix: [
            p.bw_mix_red,
            p.bw_mix_orange,
            p.bw_mix_yellow,
            p.bw_mix_green,
            p.bw_mix_aqua,
            p.bw_mix_blue,
            p.bw_mix_purple,
            p.bw_mix_magenta,
        ],
        bw_active: p.bw_active != 0.0,
        sharpen_amount: p.sharpen_amount,
        sharpen_radius: p.sharpen_radius,
        sharpen_detail: p.sharpen_detail,
        sharpen_masking: p.sharpen_masking,
        nr_luminance: p.nr_luminance,
        nr_color: p.nr_color,
        contrast: p.contrast,
        capture_sharpening,
        // The view tail ALWAYS runs the Auto Profile curve + residual-LUT passes
        // (`build_live_chain`), and both require valid runtime data:
        // `AutoProfileCurvePass` asserts a `PROFILE_CURVE_FLAT_LEN` curve, and
        // `ResidualLutPass` asserts `size >= 2` + `size³·3` data. When the host
        // supplies NO Auto artifacts (Neutral, or an image with no Auto tail), the
        // pointers are NULL → empty here, which would panic the passes. Default to
        // the IDENTITY curve + an identity 2³ LUT: both are exact no-ops, so the
        // tail collapses to plain AgX — the canonical `Profile::Neutral` render.
        profile_curve_flat: curve_flat_or_identity(p),
        residual_lut_size,
        residual_lut_data,
        // Marshal the target_primaries tag (#1337). Unknown values default to
        // 0 = sRGB (the legacy-compatible default), matching the WGSL branch.
        target_primaries: p.target_primaries,
        // Marshal the input_shape tag (#1331). Unknown values (> 2) default to
        // `PostDcpRec2020Fp16` (the full RAW chain) — a safe conservative fallback.
        input_shape: match p.input_shape {
            1 => InputShape::LinearRec2020Fp16,
            2 => InputShape::SrgbGammaEncoded8,
            _ => InputShape::PostDcpRec2020Fp16,
        },
        // The frame's DNG NoiseProfile + ISO (#1714) — what the NR stages'
        // per-pixel modulation is derived from. A null pointer / zero length is
        // "no profile", which is the flat filter raw-core runs at
        // `noise_profile: None`.
        noise_profile: read_floats(p.noise_profile_ptr, p.noise_profile_len as usize),
        iso: p.iso,
        // Film look (epic #2683, Task 8). `film_lut_or_off` is the single
        // gate: a null pointer, a zero size, OR a `len` that doesn't match
        // `size³·3` all collapse to "off" (empty data, size 0) rather than
        // risking a read past a mismatched host buffer — `build_split`'s
        // `film_lut_size > 0` presence check then omits `FilmLutPass` entirely.
        film_strength: p.film_strength,
        film_lut_size,
        film_lut_key: p.film_lut_key,
        film_lut_data,
        // Display-referred point curves (#2232) — same flat-pair marshalling
        // as `tone_curves` above, into the sibling GPU-inputs shape.
        display_tone_curves: raw_gpu::DisplayToneCurveInputs {
            master: read_points(p.display_tone_curve_luma_ptr, p.display_tone_curve_luma_len),
            red: read_points(p.display_tone_curve_red_ptr, p.display_tone_curve_red_len),
            green: read_points(
                p.display_tone_curve_green_ptr,
                p.display_tone_curve_green_len,
            ),
            blue: read_points(p.display_tone_curve_blue_ptr, p.display_tone_curve_blue_len),
        },
    }
}

/// The host-declared film LUT edge + grid, or `(0, empty)` ("off") when the
/// pointer is null, `size < 2` (mirrors `MlutError::DegenerateGrid` — no
/// tetrahedral sample is possible below a 2×2×2 lattice), or `len` doesn't
/// match `size³·3` exactly. Unlike the always-present residual LUT (which
/// falls back to an identity lattice), film has a real "absent" state, so a
/// mismatch is logged and gated off rather than substituted — never a read
/// past the caller's slice.
///
/// # Safety
/// `ptr` valid for `len` f32 reads, or null.
unsafe fn film_lut_or_off(p: &MapleGpuLiveParams) -> (u32, Cow<'_, [f32]>) {
    let size = p.film_lut_size as usize;
    let expected = size
        .checked_mul(size)
        .and_then(|v| v.checked_mul(size))
        .and_then(|v| v.checked_mul(3));
    if p.film_lut_ptr.is_null() || size < 2 || expected != Some(p.film_lut_len) {
        return (0, Cow::Borrowed(&[]));
    }
    (
        p.film_lut_size,
        Cow::Borrowed(std::slice::from_raw_parts(p.film_lut_ptr, p.film_lut_len)),
    )
}

/// The host's immutable Auto curve, or a process-lifetime identity curve.
/// The latter also avoids allocating a default curve on every Neutral frame.
unsafe fn curve_flat_or_identity(p: &MapleGpuLiveParams) -> Cow<'_, [f32]> {
    use raw_core::view::auto_profile::{ProfileCurve, PROFILE_CURVE_FLAT_LEN};
    if !p.profile_curve_ptr.is_null() && p.profile_curve_len == PROFILE_CURVE_FLAT_LEN {
        return Cow::Borrowed(std::slice::from_raw_parts(
            p.profile_curve_ptr,
            p.profile_curve_len,
        ));
    }
    static IDENTITY: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    Cow::Borrowed(IDENTITY.get_or_init(|| ProfileCurve::identity().to_flat()))
}

/// Validate edge and length together; invalid data must use the matching 2³
/// identity edge as well as its data, never a 49³ edge with a 2³ allocation.
unsafe fn residual_or_identity(p: &MapleGpuLiveParams) -> (usize, Cow<'_, [f32]>) {
    use raw_core::view::auto_profile::lut::ColorLut;
    let size = p.residual_lut_size as usize;
    let expected = size
        .checked_mul(size)
        .and_then(|v| v.checked_mul(size))
        .and_then(|v| v.checked_mul(3));
    if !p.residual_lut_ptr.is_null() && size >= 2 && expected == Some(p.residual_lut_len) {
        return (
            size,
            Cow::Borrowed(std::slice::from_raw_parts(
                p.residual_lut_ptr,
                p.residual_lut_len,
            )),
        );
    }
    static IDENTITY: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    (
        2,
        Cow::Borrowed(IDENTITY.get_or_init(|| ColorLut::identity(2).data)),
    )
}

#[cfg(test)]
mod tests {
    use super::parametric_split_or_defaults;

    #[test]
    fn all_zero_triple_falls_back_to_the_canonical_defaults() {
        // A stale host built before #3152 (or one that zero-initializes the
        // struct) leaves EVERY split field at 0.0 — must read as "absent",
        // not "every split point at axis 0".
        assert_eq!(
            parametric_split_or_defaults(0.0, 0.0, 0.0),
            [25.0, 50.0, 75.0]
        );
    }

    #[test]
    fn nonzero_triple_passes_through_unchanged() {
        assert_eq!(
            parametric_split_or_defaults(15.0, 55.0, 82.0),
            [15.0, 55.0, 82.0]
        );
    }

    #[test]
    fn a_genuine_zero_in_an_otherwise_nonzero_triple_is_honored() {
        // Copilot review on #3219: gating each field independently made it
        // impossible for a live host to ever set `parametric_shadow_split`
        // to exactly 0, which is a normal in-range axis position per the
        // documented `[0, 100]` contract. Only an ALL-zero triple is
        // "absent" — a partial zero must pass through.
        assert_eq!(
            parametric_split_or_defaults(0.0, 55.0, 82.0),
            [0.0, 55.0, 82.0]
        );
        assert_eq!(
            parametric_split_or_defaults(15.0, 0.0, 82.0),
            [15.0, 0.0, 82.0]
        );
        assert_eq!(
            parametric_split_or_defaults(15.0, 55.0, 0.0),
            [15.0, 55.0, 0.0]
        );
    }
}

#[cfg(test)]
#[path = "params_borrow_tests.rs"]
mod borrow_tests;
