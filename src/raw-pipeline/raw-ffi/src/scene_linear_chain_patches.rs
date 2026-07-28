//! Patch-compositing scene-linear FFI entries (#1486).
//!
//! The Apple host holds baked inpaint patches as `.f16` blobs under
//! `.maple/inpaint/`. These entries let it hand that blob straight across the
//! C boundary: the blob is decoded with `pipeline::patches_from_blob`, then
//! composited at the pre-user-grade seam by
//! `pipeline::apply_scene_linear_chain[_f32]_with_patches` so the patch rides
//! every downstream stage — WB, exposure, tone, AgX — exactly like sensor data.
//!
//! An empty blob (`patches_len == 0`) is bit-identical to the plain entry, so
//! the host can call these unconditionally and pay nothing when the image has
//! no removals.

use super::*;

/// Decode the host's patch blob into owned `InpaintPatch`es.
///
/// # Safety
/// When `len > 0`, `ptr` must be valid for reads of `len` bytes.
unsafe fn patches_from_ffi(
    ptr: *const u8,
    len: usize,
) -> Result<Vec<raw_core::types::InpaintPatch>, String> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if ptr.is_null() {
        return Err("patches pointer is null but patches_len > 0".to_string());
    }
    let blob = std::slice::from_raw_parts(ptr, len);
    raw_core::pipeline::patches_from_blob(blob)
}

/// Shared guard/decode preamble for both entries. Returns the lane count and
/// the decoded patches, or the error code the caller should return.
///
/// # Safety
/// `params` must be a valid `MapleAdjustmentParams` pointer.
unsafe fn prepare(
    who: &str,
    null_input: bool,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    patches_ptr: *const u8,
    patches_len: usize,
) -> Result<(usize, Vec<raw_core::types::InpaintPatch>), i32> {
    if null_input || params.is_null() {
        set_last_error(format!("{}: null pointer", who));
        return Err(1);
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "{}: zero dimension width={} height={}",
            who, width, height
        ));
        return Err(2);
    }
    // Same checked-multiply guard as the plain entries: at u32::MAX dims the
    // RGBA lane product is ~2^66 and would wrap a 64-bit usize, feeding
    // nonsense to from_raw_parts (UB).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "{}: pixel-count overflow width={} height={}",
                who, width, height
            ));
            return Err(3);
        }
    };
    let patches = match patches_from_ffi(patches_ptr, patches_len) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{}: {}", who, e));
            return Err(10);
        }
    };
    Ok((lanes, patches))
}

/// fp16 sibling of [`maple_apply_scene_linear_chain`] that composites
/// `patches` before the chain runs. `patches_ptr`/`patches_len` carry the
/// `pipeline::patches_to_blob` encoding; a zero length means "no patches" and
/// yields bit-identical output to the plain entry.
///
/// Returns 0 on success. Error codes match the plain entry (1 null, 2 zero
/// dimension, 3 overflow, 8 chain failure, 9 lane mismatch) plus 10 for a
/// malformed patch blob. Call `maple_last_error` for detail.
///
/// # Safety
/// `in_ptr` and `out_ptr` must each be valid for `4 * width * height` `u16`
/// lanes; `params` must point to a caller-owned `MapleAdjustmentParams`.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain_with_patches(
    in_ptr: *const u16,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    patches_ptr: *const u8,
    patches_len: usize,
    out_ptr: *mut u16,
) -> i32 {
    const WHO: &str = "apply_scene_linear_chain_with_patches";
    let (lanes, patches) = match prepare(
        WHO,
        in_ptr.is_null() || out_ptr.is_null(),
        width,
        height,
        params,
        patches_ptr,
        patches_len,
    ) {
        Ok(v) => v,
        Err(rc) => return rc,
    };
    let p = &*params;
    let ci = chain_inputs_from_params(p);
    let opts = ci.options(p.skip_agx != 0);
    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::apply_scene_linear_chain_with_patches(
        in_slice, width, height, &ci.model, &opts, &patches,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{}: {}", WHO, e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "{}: chain returned {} lanes, expected {}",
            WHO,
            out_vec.len(),
            lanes
        ));
        return 9;
    }
    std::slice::from_raw_parts_mut(out_ptr, lanes).copy_from_slice(&out_vec);
    0
}

/// f32 sibling of [`maple_apply_scene_linear_chain_with_patches`]. Identical
/// semantics and error codes; input and output are packed f32 RGBA.
///
/// # Safety
/// `in_ptr` and `out_ptr` must each be valid for `4 * width * height` `f32`
/// lanes; `params` must point to a caller-owned `MapleAdjustmentParams`.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain_f32_with_patches(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    patches_ptr: *const u8,
    patches_len: usize,
    out_ptr: *mut f32,
) -> i32 {
    const WHO: &str = "apply_scene_linear_chain_f32_with_patches";
    let (lanes, patches) = match prepare(
        WHO,
        in_ptr.is_null() || out_ptr.is_null(),
        width,
        height,
        params,
        patches_ptr,
        patches_len,
    ) {
        Ok(v) => v,
        Err(rc) => return rc,
    };
    let p = &*params;
    let ci = chain_inputs_from_params(p);
    let opts = ci.options(p.skip_agx != 0);
    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::apply_scene_linear_chain_f32_with_patches(
        in_slice, width, height, &ci.model, &opts, &patches,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{}: {}", WHO, e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "{}: chain returned {} lanes, expected {}",
            WHO,
            out_vec.len(),
            lanes
        ));
        return 9;
    }
    std::slice::from_raw_parts_mut(out_ptr, lanes).copy_from_slice(&out_vec);
    0
}
