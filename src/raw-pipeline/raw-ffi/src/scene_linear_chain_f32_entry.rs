//! f32 variant of the scene-linear chain FFI entry, split into a sibling
//! module for the 600-line file budget. Same contract as the fp16 entry in
//! `scene_linear_chain.rs` — see that file's docs.

use super::*;

#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_scene_linear_chain_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_scene_linear_chain_f32: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // Same checked-multiply guards as the fp16 entry — at u32::MAX dims
    // the RGBA lane product is ~2^66, which exceeds 64-bit usize. Without
    // the guards the unchecked product would wrap and feed nonsense to
    // from_raw_parts (UB).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "apply_scene_linear_chain_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };
    let p = &*params;

    // Shared slider -> model + chain-input mapping (#1486) — identical to the
    // fp16 entry, see `scene_linear_chain_inputs.rs`.
    let ci = chain_inputs_from_params(p);
    let opts = ci.options(p.skip_agx != 0);

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);
    let out_vec = match raw_core::pipeline::apply_scene_linear_chain_f32(
        in_slice, width, height, &ci.model, &opts,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_scene_linear_chain_f32: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_scene_linear_chain_f32: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}
