//! Agent scope evidence and paired CPU coverage (#4104). HUD ABI unchanged.
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::scope::inspection::{reduce_scope_evidence, ScopeEvidence};
#[repr(C)]
#[derive(Default)]
pub struct MapleScopeEvidence {
    pub sample_count: u32,
    pub confidence: u32,
    pub minimum_samples: u32,
    pub _pad: u32,
    pub mean_cb: f64,
    pub mean_cr: f64,
    pub angle_deg: f64,
    pub deviation_deg: f64,
    pub resultant_length: f64,
    pub skin_line_deg: f64,
    pub skin_wedge_deg: f64,
}
impl From<ScopeEvidence> for MapleScopeEvidence {
    fn from(v: ScopeEvidence) -> Self {
        Self {
            sample_count: v.sample_count,
            confidence: v.confidence,
            minimum_samples: raw_core::scope::inspection::MIN_CHROMATIC_SAMPLES,
            _pad: 0,
            mean_cb: v.mean_cb,
            mean_cr: v.mean_cr,
            angle_deg: v.angle_deg,
            deviation_deg: v.deviation_deg,
            resultant_length: v.resultant_length,
            skin_line_deg: raw_core::scope::inspection::SKIN_LINE_DEG,
            skin_wedge_deg: raw_core::scope::inspection::SKIN_WEDGE_DEG,
        }
    }
}
/// Reduce exact bounded RGBA8 sRGB pixels. Alpha is coverage when weighted=1.
/// Returns0 success,-1 invalid input,99 contained panic.
/// # Safety
/// rgba is readable for len bytes; out is writable and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_scope_evidence(
    rgba: *const u8,
    len: usize,
    width: u32,
    height: u32,
    weighted: u32,
    out: *mut MapleScopeEvidence,
) -> i32 {
    if rgba.is_null()
        || out.is_null()
        || weighted > 1
        || width == 0
        || height == 0
        || width > 512
        || height > 512
        || len as u64 != u64::from(width) * u64::from(height) * 4
    {
        set_last_error("scope evidence: invalid bounded pixels/weights".into());
        return -1;
    }
    catch_panic_rc("scope evidence", || {
        match reduce_scope_evidence(
            std::slice::from_raw_parts(rgba, len),
            width,
            height,
            weighted != 0,
        ) {
            Ok(v) => {
                *out = v.into();
                0
            }
            Err(e) => {
                set_last_error(e.into());
                -1
            }
        }
    })
}
/// Canonical CPU chain + sRGB encode, selected geometry-times-range in alpha.
/// Hosts apply existing Auto/film tail to RGB and crop both fields together.
/// scope_layer=-1 explicitly means whole frame. Invalid positive targets fail.
/// # Safety
/// Input/output readable/writable for lanes aligned floats; params/arrays use
/// the existing chain ABI. Input/output may alias (chain copies input).
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_scope_rgba_f32(
    input: *const f32,
    lanes: usize,
    width: u32,
    height: u32,
    params: *const crate::MapleAdjustmentParams,
    scope_layer: i32,
    output: *mut f32,
) -> i32 {
    if input.is_null()
        || params.is_null()
        || output.is_null()
        || width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || lanes as u64 != u64::from(width) * u64::from(height) * 4
        || scope_layer < -1
    {
        set_last_error("scope CPU: invalid buffer/target".into());
        return -1;
    }
    catch_panic_rc("scope CPU", || {
        let ci = crate::scene_linear_chain::chain_inputs_from_params(&*params);
        if scope_layer >= 0 && scope_layer as usize >= ci.model.local_adjustments.len() {
            set_last_error("scope CPU: selected layer is unavailable".into());
            return -1;
        }
        let (chain, weights) = match raw_core::pipeline::apply_scene_linear_chain_f32_scoped(
            std::slice::from_raw_parts(input, lanes),
            width,
            height,
            &ci.model,
            &ci.options((*params).skip_agx != 0),
            (scope_layer >= 0).then_some(scope_layer as usize),
        ) {
            Ok(v) => v,
            Err(e) => {
                set_last_error(e.to_string());
                return -1;
            }
        };
        let rc = crate::scene_linear_chain::maple_encode_display_f32(
            chain.as_ptr(),
            width,
            height,
            0,
            output,
        );
        if rc != 0 {
            return rc;
        }
        for (i, pixel) in std::slice::from_raw_parts_mut(output, lanes)
            .chunks_exact_mut(4)
            .enumerate()
        {
            pixel[3] = weights.as_ref().map(|w| w[i]).unwrap_or(1.0);
        }
        0
    })
}

/// Paired bounded ROI snapshot from final encoded sRGB+canonical coverage.
/// CPU/GPU use the same box-cell sampling contract. Output capacity512²*4.
/// # Safety
/// Input valid for lanes floats; output/dimensions writable and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_scope_snapshot_f32(
    rgba: *const f32,
    lanes: usize,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    region_width: u32,
    region_height: u32,
    weighted: u32,
    output: *mut u8,
    capacity: usize,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    if rgba.is_null()
        || output.is_null()
        || out_width.is_null()
        || out_height.is_null()
        || capacity < 512 * 512 * 4
        || width > 4096
        || height > 4096
        || weighted > 1
        || lanes as u64 != u64::from(width) * u64::from(height) * 4
    {
        set_last_error("scope snapshot: invalid bounded source/capacity".into());
        return -1;
    }
    catch_panic_rc("scope snapshot", || {
        match raw_core::scope::inspection_snapshot::snapshot_scope_rgba(
            std::slice::from_raw_parts(rgba, lanes),
            width,
            height,
            (x, y, region_width, region_height),
            weighted != 0,
        ) {
            Ok((w, h, pixels)) => {
                std::ptr::copy_nonoverlapping(pixels.as_ptr(), output, pixels.len());
                *out_width = w;
                *out_height = h;
                0
            }
            Err(e) => {
                set_last_error(e.into());
                -1
            }
        }
    })
}
