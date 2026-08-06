//! Curves-aware fused per-tick entry (#2576).
//!
//! `MapleAdjustmentParams` is a scalars-only ABI — user point tone curves
//! (variable-length knot lists) cannot ride it, so hosts whose CPU fallback
//! renders through `maple_apply_chain_and_encode_display_f32` had no way to
//! preview a point-curve edit (the GPU live path takes knot pointers in
//! `MapleGpuLiveParams`; the develop path parses them from the sidecar).
//! This sibling entry keeps the params struct untouched (no ABI break for
//! existing hosts) and takes the four per-channel knot lists alongside it,
//! injecting them into the SAME model the scalar entry builds — the curve
//! therefore applies at its canonical stage position, identical to the
//! develop path, not as a post-hoc approximation.
//!
//! A null / empty `curves` pointer makes this entry behave exactly like
//! `maple_apply_chain_and_encode_display_f32`.

use crate::error::set_last_error;
use crate::scene_linear_chain::{maple_encode_display_srgb_f32, MapleAdjustmentParams};
use crate::scene_linear_chain::chain_inputs_from_params;
use raw_core::types::{ToneCurve, ToneCurveMode};

/// User point tone curves for the curves-aware chain entry. Each pointer is
/// a flat `[x0, y0, x1, y1, ...]` f32 list; `len` counts FLOATS (2× points),
/// matching `MapleGpuLiveParams`' tone-curve fields. Null/zero-length lists
/// are the identity for that channel.
#[repr(C)]
pub struct MapleToneCurves {
    pub luma_ptr: *const f32,
    pub luma_len: usize,
    pub red_ptr: *const f32,
    pub red_len: usize,
    pub green_ptr: *const f32,
    pub green_len: usize,
    pub blue_ptr: *const f32,
    pub blue_len: usize,
    /// 0 = PerChannel, 1 = RatioPreserving.
    pub mode: u32,
}

/// # Safety
/// `ptr` must be valid for `len` f32 reads, or null. A trailing odd float
/// (len not a multiple of 2) is ignored rather than read as a half-pair.
unsafe fn curve_from_flat(ptr: *const f32, len: usize) -> ToneCurve {
    if ptr.is_null() || len < 2 {
        return ToneCurve::default();
    }
    let flat = std::slice::from_raw_parts(ptr, len);
    ToneCurve::new(flat.chunks_exact(2).map(|c| (c[0], c[1])).collect())
}

/// Curves-aware sibling of `maple_apply_chain_and_encode_display_f32`:
/// scene-linear chain then display encode over one f32 RGBA buffer, with the
/// user point tone curves applied at their canonical chain stage. Buffer
/// contract, error codes, and aliasing rules match the scalar fused entry.
///
/// # Safety
/// Pointer contracts as for the scalar entry; additionally `curves` (when
/// non-null) must point to a valid `MapleToneCurves` whose lists satisfy
/// [`curve_from_flat`]'s contract for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_display_curves_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_chain_and_encode_display_curves_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_chain_and_encode_display_curves_f32: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "apply_chain_and_encode_display_curves_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };
    let p = &*params;

    // Same shared slider -> model mapping as every chain entry (#1486), then
    // inject the point curves the scalar ABI cannot carry.
    let mut ci = chain_inputs_from_params(p);
    if !curves.is_null() {
        let c = &*curves;
        ci.model.tone_curve_luma = curve_from_flat(c.luma_ptr, c.luma_len);
        ci.model.tone_curve_red = curve_from_flat(c.red_ptr, c.red_len);
        ci.model.tone_curve_green = curve_from_flat(c.green_ptr, c.green_len);
        ci.model.tone_curve_blue = curve_from_flat(c.blue_ptr, c.blue_len);
        ci.model.tone_curve_mode = match c.mode {
            1 => ToneCurveMode::RatioPreserving,
            _ => ToneCurveMode::PerChannel,
        };
    }
    let opts = ci.options(p.skip_agx != 0);

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);
    let out_vec = match raw_core::pipeline::apply_scene_linear_chain_f32(
        in_slice, width, height, &ci.model, &opts,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_chain_and_encode_display_curves_f32: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_chain_and_encode_display_curves_f32: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    maple_encode_display_srgb_f32(out_vec.as_ptr(), width, height, out_ptr)
}
