//! C-params → [`FullChainInputs`] marshalling for the gpu-gated live FFI,
//! split out of `gpu_live.rs` (600-LOC file budget, same pattern as
//! `raw_gpu::live_session::limits`): the `(ptr, len)` readers, the WB-matrix
//! derivation, and the identity fallbacks for absent Auto Profile artifacts.
//! Pure relocation; no behavior change.

use super::MapleGpuLiveParams;
use raw_gpu::FullChainInputs;

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
    let wb_matrix = match wb_method {
        raw_core::types::WbMethod::Cat16 => {
            raw_core::stages::white_balance::wb_cat16_matrix(p.temperature, p.tint).0
        }
        raw_core::types::WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(p.temperature, p.tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    };

    let capture_sharpening = if p.capture_sharpening_enabled != 0 {
        Some(raw_gpu::CaptureSharpeningParams {
            sigma: p.capture_sharpening_sigma,
            iterations: p.capture_sharpening_iterations,
            highlight_threshold: p.capture_sharpening_highlight_threshold,
            strength: p.capture_sharpening_strength,
        })
    } else {
        None
    };

    FullChainInputs {
        wb_matrix,
        wb_temperature: p.temperature,
        wb_tint: p.tint,
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
