//! #4738 (b): curves-aware twin of `maple_apply_chain_and_encode_display_target_f32`.
//!
//! Apple's refine / export path encodes to the canvas primaries (sRGB or
//! Display P3) through the target entry, which cannot carry tone curves.
//! This entry is the same chain + target encode with a `MapleToneCurves`
//! argument (point curves, mode, display curves, parametric regions and
//! splits). A null `curves` renders bit-for-bit like the curve-less entry.

use crate::error::set_last_error;
use crate::scene_linear_chain::maple_encode_display_f32;
use crate::scene_linear_chain::{chain_inputs_from_params, MapleAdjustmentParams};
use crate::scene_linear_chain_curves::{inject_tone_curves, MapleChainWindow, MapleToneCurves};

/// # Safety
/// `in_ptr`/`out_ptr` must each address `width * height * 4` `f32`s;
/// `params` must point at a valid `MapleAdjustmentParams`; `curves` is null
/// or points at a valid `MapleToneCurves` whose lists satisfy
/// `inject_tone_curves`' contract. `target_primaries` is `0` (sRGB) or `1`
/// (Display P3).
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_display_target_curves_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    target_primaries: u32,
    out_ptr: *mut f32,
) -> i32 {
    crate::error::catch_panic_rc(
        "maple_apply_chain_and_encode_display_target_curves_f32",
        || {
            chain_and_encode_target(
                in_ptr,
                width,
                height,
                params,
                curves,
                target_primaries,
                out_ptr,
                None,
                std::ptr::null(),
            )
        },
    )
}

/// Windowed twin of [`maple_apply_chain_and_encode_display_target_curves_f32`]
/// for a native-detail patch (#5169): the chain runs as
/// `apply_scene_linear_chain_f32_windowed`, so the S/H detail mask is sized
/// from the full frame and masks, vignette and grain use full-frame
/// coordinates. The patch must carry
/// [`maple_scene_linear_chain_window_reach_px`] of context around what the
/// caller publishes. Dehaze (global or per mask) recovers with `haze`, the
/// frame's maps from `maple_scene_linear_chain_haze_map_f32` (#3287); a null
/// `haze` with dehaze engaged returns `8`.
///
/// # Safety
/// As [`maple_apply_chain_and_encode_display_target_curves_f32`];
/// additionally `window` must point at a valid `MapleChainWindow` and `haze`
/// be null or a live `MapleHazeMap`.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_display_target_window_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    target_primaries: u32,
    window: *const MapleChainWindow,
    haze: *const crate::MapleHazeMap,
    out_ptr: *mut f32,
) -> i32 {
    crate::error::catch_panic_rc(
        "maple_apply_chain_and_encode_display_target_window_f32",
        || {
            let Some(window) = window.as_ref() else {
                set_last_error("native detail: null window".into());
                return 1;
            };
            chain_and_encode_target(
                in_ptr,
                width,
                height,
                params,
                curves,
                target_primaries,
                out_ptr,
                Some(window.into()),
                haze,
            )
        },
    )
}

/// Per-edge context, in patch pixels, a windowed patch needs for `params`
/// (#5169). `0` when either pointer is null.
///
/// # Safety
/// `params` must point at a valid `MapleAdjustmentParams` (with its local
/// adjustment and noise-profile pointers valid) and `window` at a valid
/// `MapleChainWindow`, or be null.
#[no_mangle]
pub unsafe extern "C" fn maple_scene_linear_chain_window_reach_px(
    params: *const MapleAdjustmentParams,
    window: *const MapleChainWindow,
) -> u32 {
    crate::error::catch_panic("maple_scene_linear_chain_window_reach_px", 0, || {
        match (params.as_ref(), window.as_ref()) {
            (Some(params), Some(window)) => chain_inputs_from_params(params).map_or(0, |ci| {
                raw_core::pipeline::scene_linear_chain_window_reach_px(&ci.model, window.into())
            }),
            _ => 0,
        }
    })
}

unsafe fn chain_and_encode_target(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    target_primaries: u32,
    out_ptr: *mut f32,
    window: Option<raw_core::pipeline::ChainWindow>,
    haze: *const crate::MapleHazeMap,
) -> i32 {
    let context = if window.is_some() {
        "apply_chain_and_encode_display_target_window_f32"
    } else {
        "apply_chain_and_encode_display_target_curves_f32"
    };
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error(format!("{context}: null pointer"));
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "{context}: zero dimension width={width} height={height}"
        ));
        return 2;
    }
    if target_primaries > 1 {
        set_last_error(format!(
            "{context}: unsupported target_primaries={target_primaries}"
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
                "{context}: pixel-count overflow width={width} height={height}"
            ));
            return 3;
        }
    };
    let p = &*params;
    let mut ci = match chain_inputs_from_params(p) {
        Ok(ci) => ci,
        Err(e) => {
            set_last_error(e);
            return 8;
        }
    };
    if !curves.is_null() {
        inject_tone_curves(&mut ci.model, &*curves);
    }
    let opts = raw_core::pipeline::ChainOptions {
        haze_map: haze.as_ref().map(|haze| &*haze.0),
        ..ci.options(p.skip_agx != 0)
    };
    let input = std::slice::from_raw_parts(in_ptr, lanes);
    let chained = match window {
        Some(window) => raw_core::pipeline::apply_scene_linear_chain_f32_windowed(
            input, width, height, &ci.model, &opts, None, window,
        ),
        None => {
            raw_core::pipeline::apply_scene_linear_chain_f32(input, width, height, &ci.model, &opts)
        }
    };
    let rendered = match chained {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{context}: {e}"));
            return 8;
        }
    };
    if rendered.len() != lanes {
        set_last_error(format!(
            "{context}: chain returned {} lanes, expected {lanes}",
            rendered.len()
        ));
        return 9;
    }
    maple_encode_display_f32(rendered.as_ptr(), width, height, target_primaries, out_ptr)
}
