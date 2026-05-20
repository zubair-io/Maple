//! Per-tick scene-linear chain (Option C) — collapses the duplicate
//! Apple-Metal kernel chain (WB → tone → vibrance → saturation →
//! clarity → texture → dehaze → nr_luminance → AgX) into a single FFI
//! call into the canonical Rust implementation.
//!
//! Sharpen + nr_color stay on the GPU (Metal compute) — they're too
//! expensive on CPU to hit the per-tick budget. Everything else has CPU
//! cost <2ms at viewport size and runs here so Rust is the single
//! source of truth for those algorithms.
//!
//! Caller-provided input and output buffers. Note: the FFI entry itself
//! is a thin shim, but `raw_core::pipeline::apply_scene_linear_chain`
//! currently returns an owned `Vec<u16>` that we `copy_from_slice` into
//! `out_ptr` — so there is one intermediate heap allocation of
//! `8 * width * height` bytes per call. Removing it requires refactoring
//! the raw-core entry to write into a caller-provided slice and is
//! tracked separately. Input and output are both packed fp16 RGBA
//! (8 bytes/pixel),
//! `extendedLinearITUR_2020` scene-linear, straight alpha. Output is
//! post-AgX (display-linear Rec.2020) when `skip_agx == 0`, scene-linear
//! when non-zero. The `skip_agx` flag exists for the non-RAW path:
//! HEIF / JPEG / PNG / screenshot input is already display-encoded, so
//! AgX would double-tone-map (white compresses to ~0.82). See
//! `processSceneLinearNonRaw` in `ImageEditPipeline.swift` for the
//! matching commit `4a8c655`.

use crate::error::set_last_error;

/// C-ABI mirror of the slider subset that the per-tick chain consumes.
/// Kept flat (all f32) so cbindgen / Swift's `@_silgen_name` import
/// produce a layout-compatible struct on both sides.
///
/// Field order matches the Swift `MapleAdjustmentParams` initialiser at
/// `PipelineRenderer.swift::makeAdjustmentParams` byte-for-byte —
/// changing the order here means changing it there.
#[repr(C)]
pub struct MapleAdjustmentParams {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    pub clarity: f32,
    pub texture: f32,
    pub nr_luminance: f32,
    pub dehaze: f32,
    pub decoded_temperature: f32,
    pub decoded_tint: f32,
    /// 1 = skip the AgX view transform (non-RAW path: input is already
    /// display-encoded). 0 = apply AgX (RAW path).
    pub skip_agx: u32,
}

/// Run the cheap-stage scene-linear chain over a caller-provided fp16 RGBA
/// buffer. Returns 0 on success, non-zero on error (call `maple_last_error`).
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `8 * width * height` bytes (= `4 * width * height` fp16 lanes). The
/// caller owns both buffers. This entry does not free anything, but does
/// perform one intermediate heap allocation of the same size as the output
/// buffer (the wrapped `raw_core` entry returns an owned `Vec<u16>` which
/// is then copied into `out_ptr`).
/// `out_ptr` may alias `in_ptr` only if the caller is willing to lose the
/// input on error — current implementation copies the result at the end
/// so partial in-place is safe but partial-write semantics are undefined
/// on error. Recommend distinct buffers.
///
/// `params` must be a valid pointer to a `MapleAdjustmentParams` struct
/// the caller owns for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain(
    in_ptr: *const u16,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut u16,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_scene_linear_chain: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_scene_linear_chain: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // checked_mul (not saturating_mul) — on overflow we want to bail with
    // an error rc, not return usize::MAX and feed that to from_raw_parts
    // (UB). Width and height are u32 so on a 64-bit usize the product
    // can't overflow today (max ~2^64 vs 2^32 * 2^32 * 4 ≈ 2^66 — but
    // checked_mul is correct under any future widening too).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) if n > 0 => n,
        Some(_) => {
            set_last_error("apply_scene_linear_chain: zero-lane buffer".into());
            return 3;
        }
        None => {
            set_last_error(format!(
                "apply_scene_linear_chain: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };
    let p = &*params;

    // Build an AdjustmentModel from the C-ABI params. Fields the chain
    // uses get copied across; sharpen + nr_color stay default (they're
    // applied on the GPU after this call returns) and other fields keep
    // the AdjustmentModel::default() values so this matches the Rust
    // pipeline's behavior on the cheap-stage subset.
    let mut model = raw_core::xmp::AdjustmentModel::default();
    model.temperature = p.temperature;
    model.tint = p.tint;
    model.exposure = p.exposure;
    model.contrast = p.contrast;
    model.highlights = p.highlights;
    model.shadows = p.shadows;
    model.whites = p.whites;
    model.blacks = p.blacks;
    model.vibrance = p.vibrance;
    model.saturation = p.saturation;
    model.clarity = p.clarity;
    model.texture = p.texture;
    model.nr_luminance = p.nr_luminance;
    model.dehaze = p.dehaze;

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::apply_scene_linear_chain(
        in_slice,
        width,
        height,
        &model,
        p.decoded_temperature,
        p.decoded_tint,
        p.skip_agx != 0,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_scene_linear_chain: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_scene_linear_chain: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}
