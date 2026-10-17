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
use crate::scene_linear_chain_curves::{inject_tone_curves, MapleToneCurves};

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
            )
        },
    )
}

unsafe fn chain_and_encode_target(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    target_primaries: u32,
    out_ptr: *mut f32,
) -> i32 {
    const CONTEXT: &str = "apply_chain_and_encode_display_target_curves_f32";
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error(format!("{CONTEXT}: null pointer"));
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "{CONTEXT}: zero dimension width={width} height={height}"
        ));
        return 2;
    }
    if target_primaries > 1 {
        set_last_error(format!(
            "{CONTEXT}: unsupported target_primaries={target_primaries}"
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
                "{CONTEXT}: pixel-count overflow width={width} height={height}"
            ));
            return 3;
        }
    };
    let p = &*params;
    let mut ci = chain_inputs_from_params(p);
    if !curves.is_null() {
        inject_tone_curves(&mut ci.model, &*curves);
    }
    let opts = ci.options(p.skip_agx != 0);
    let input = std::slice::from_raw_parts(in_ptr, lanes);
    let rendered = match raw_core::pipeline::apply_scene_linear_chain_f32(
        input, width, height, &ci.model, &opts,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{CONTEXT}: {e}"));
            return 8;
        }
    };
    if rendered.len() != lanes {
        set_last_error(format!(
            "{CONTEXT}: chain returned {} lanes, expected {lanes}",
            rendered.len()
        ));
        return 9;
    }
    maple_encode_display_f32(rendered.as_ptr(), width, height, target_primaries, out_ptr)
}
