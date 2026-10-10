//! #1472: exact prepared Auto tail inside the existing CPU chain/encode call.
//! Borrow immutable artifacts; do not bake/sample an approximate CI cube or
//! allocate another image buffer. Existing entry points remain unchanged.
use crate::scene_linear_chain::MapleAdjustmentParams;
use raw_core::view::auto_profile::{
    apply::apply_prepared_rgba, ProfileCurve, PROFILE_CURVE_FLAT_LEN,
};

/// Run the existing fused chain and sRGB encode, then apply the prepared
/// curve/residual in place before host quantization. Optional absent artifacts
/// are a no-op. Alpha is preserved. Invalid artifacts reject before rendering.
/// Returns existing fused codes, or -1 for malformed artifacts.
///
/// # Safety
/// Input/output contain width*height*4 aligned f32 lanes; params is valid.
/// Curve is null with len 0, or points to 220 aligned finite f32. Residual is
/// null with size/len 0, or points to size³*3 aligned finite f32, size >= 2.
/// Artifacts do not overlap output and remain alive through synchronous return.
/// Input and output may alias, as in the existing fused entry.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_native_auto_f32(
    input: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curve: *const f32,
    curve_len: usize,
    residual: *const f32,
    residual_size: usize,
    residual_len: usize,
    output: *mut f32,
) -> i32 {
    let aligned = |p: *const f32| !p.is_null() && (p as usize) % std::mem::align_of::<f32>() == 0;
    let curve = if curve_len == 0 && curve.is_null() {
        None
    } else {
        if curve_len != PROFILE_CURVE_FLAT_LEN || !aligned(curve) {
            return -1;
        }
        let flat = std::slice::from_raw_parts(curve, curve_len);
        if flat.iter().any(|v| !v.is_finite()) {
            return -1;
        }
        let Some(parsed) = ProfileCurve::from_flat(flat) else {
            return -1;
        };
        Some(parsed)
    };
    let residual = if residual_size == 0 && residual_len == 0 && residual.is_null() {
        None
    } else {
        if residual_size < 2
            || !aligned(residual)
            || residual_size.checked_pow(3).and_then(|n| n.checked_mul(3)) != Some(residual_len)
            || residual_len > isize::MAX as usize / std::mem::size_of::<f32>()
        {
            return -1;
        }
        let data = std::slice::from_raw_parts(residual, residual_len);
        if data.iter().any(|v| !v.is_finite()) {
            return -1;
        }
        Some(data)
    };
    let rc = crate::scene_linear_chain_fused::maple_apply_chain_and_encode_display_f32(
        input, width, height, params, output,
    );
    if rc != 0 {
        return rc;
    }
    // The existing fused validator proved the product fits and wrote all lanes.
    let pixels = std::slice::from_raw_parts_mut(output, width as usize * height as usize * 4);
    apply_prepared_rgba(
        pixels,
        curve.as_ref(),
        residual.map(|data| (residual_size, data)),
    );
    0
}

#[cfg(test)]
#[path = "native_auto_chain_tests.rs"]
mod tests;
