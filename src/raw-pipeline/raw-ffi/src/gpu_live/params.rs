//! C-params → [`FullChainInputs`] marshalling for the gpu-gated live FFI,
//! split out of `gpu_live.rs` (600-LOC file budget, same pattern as
//! `raw_gpu::live_session::limits`): the `(ptr, len)` readers, the WB-matrix
//! derivation, and the identity fallbacks for absent Auto Profile artifacts.
//! Pure relocation; no behavior change.

use super::MapleGpuLiveParams;
use raw_gpu::{FullChainInputs, InputShape};

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

/// Build the `raw_gpu::FullChainInputs` the live chain consumes from the C params,
/// deriving the WB matrix from temp/tint the same way the CPU chain does. The
/// curve/LUT/tone-curve arrays are copied out of the caller's buffers here, so the
/// returned `FullChainInputs` owns its data and the caller's pointers need not
/// outlive the render.
///
/// # Safety
/// `p` and every non-null `(ptr, len)` it carries must be valid for the read.
pub(super) unsafe fn inputs_from_params(p: &MapleGpuLiveParams) -> FullChainInputs {
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
    let wb_frame =
        crate::scene_linear_chain::wb_frame_from_flat(&crate::scene_linear_chain::WbFrameFlat {
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
            cam_to_rec2020: &p.wb_frame_cam_to_rec2020,
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
        profile_curve_flat: curve_flat_or_identity(p.profile_curve_ptr, p.profile_curve_len),
        residual_lut_size: residual_size_or_identity(p.residual_lut_size as usize),
        residual_lut_data: residual_data_or_identity(
            p.residual_lut_ptr,
            p.residual_lut_len,
            p.residual_lut_size as usize,
        ),
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
        // Marshal the profile_id discriminant (#1722) unchanged — this layer
        // does no remapping. Downstream (`full_chain`/`live_chain`) only
        // special-cases `PROFILE_ID_ACR_MATCH` (2); every other value,
        // including 0 (Auto) and any value this FFI doesn't yet know about,
        // falls through to the AgX view tail. A stale host (zero-initialised
        // struct) reads 0, which lands on that same AgX fallback.
        profile_id: p.profile_id,
    }
}

/// The host-supplied flat Auto Profile curve, or the IDENTITY curve's flat
/// serialization when absent (NULL / wrong length). The view tail's
/// `AutoProfileCurvePass` requires a `PROFILE_CURVE_FLAT_LEN` curve; an identity
/// curve makes it a no-op (= plain AgX). Validating the length here also guards
/// against a truncated host buffer reaching the pass's assert.
///
/// # Safety
/// `ptr` valid for `len` f32 reads, or null.
unsafe fn curve_flat_or_identity(ptr: *const f32, len: usize) -> Vec<f32> {
    use raw_core::view::auto_profile::{ProfileCurve, PROFILE_CURVE_FLAT_LEN};
    let supplied = read_floats(ptr, len);
    if supplied.len() == PROFILE_CURVE_FLAT_LEN {
        supplied
    } else {
        ProfileCurve::identity().to_flat()
    }
}

/// The residual LUT edge to use: the host's when `>= 2`, else 2 (the identity
/// fallback's edge). `ResidualLutPass` asserts `size >= 2`.
fn residual_size_or_identity(size: usize) -> usize {
    if size >= 2 {
        size
    } else {
        2
    }
}

/// The host-supplied residual LUT grid, or an identity `2³` grid when absent
/// (NULL / `size < 2` / wrong length). Paired with [`residual_size_or_identity`]
/// so the size + data always agree (the pass asserts `data.len() == size³·3`).
///
/// # Safety
/// `ptr` valid for `len` f32 reads, or null.
unsafe fn residual_data_or_identity(ptr: *const f32, len: usize, size: usize) -> Vec<f32> {
    use raw_core::view::auto_profile::lut::ColorLut;
    let expected = size
        .saturating_mul(size)
        .saturating_mul(size)
        .saturating_mul(3);
    if size >= 2 {
        let supplied = read_floats(ptr, len);
        if supplied.len() == expected {
            return supplied;
        }
    }
    ColorLut::identity(2).data
}
