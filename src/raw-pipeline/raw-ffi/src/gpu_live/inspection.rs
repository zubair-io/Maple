//! On-demand paired scope snapshot, not the previous-tick HUD.
use super::*;
/// Capture this call's sRGB chain and canonical weights. out holds512²*4 bytes.
/// ROI uses buffer row coordinates; host converts top-left once.
/// Params explicitly request sRGB, scope_enabled=1 and a valid target.
/// Returns0 success,-1 invalid input,-4 render failure,99 contained panic.
/// # Safety
/// Exclusively owned live handle, valid params/arrays, writable disjoint out
/// buffer/capacity and dimensions for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_scope_snapshot(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    out: *mut u8,
    capacity: usize,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    if handle.is_null()
        || params.is_null()
        || out.is_null()
        || out_width.is_null()
        || out_height.is_null()
        || capacity < 512 * 512 * 4
        || (*handle).inner.is_null()
        || (*params).target_primaries != 0
        || (*params).scope_enabled == 0
        || (*params).scope_layer < -1
    {
        set_last_error("scope GPU: invalid handle, target or capacity".into());
        return -1;
    }
    catch_panic_rc("scope GPU", || {
        let inner = &*((*handle).inner as *const LiveHandleInner);
        let mut inputs = params::inputs_from_params(&*params);
        // Keep the layer target (the local pass records canonical alpha), but
        // do not schedule a previous-tick HUD map during explicit inspection.
        // That readback has a separately owned bounded staging buffer.
        inputs.scope.enabled = false;
        let layer = (*params).scope_layer;
        let count = raw_core::types::local_adjustment::flat::layers_from_flat(
            &inputs.local_adjustments,
            &[],
        )
        .len();
        if layer >= 0 && layer as usize >= count {
            set_last_error("scope GPU: selected layer is unavailable".into());
            return -1;
        }
        let shared = lock_shared();
        let Some(shared) = shared.as_ref() else {
            return -4;
        };
        match inner
            .session
            .inspect_scope(&shared.ctx, &inputs, (x, y, width, height))
        {
            Ok((w, h, rgba)) => {
                std::ptr::copy_nonoverlapping(rgba.as_ptr(), out, rgba.len());
                *out_width = w;
                *out_height = h;
                0
            }
            Err(e) => {
                set_last_error(e);
                -4
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use crate::scene_linear_chain_tests::default_params;
    use crate::scope_inspection::maple_apply_chain_scope_rgba_f32;
    use crate::scope_inspection_tests::fixture;
    use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments, SKIN_TONE_RANGE};
    #[test]
    fn metal_scope_roi_matches_cpu_canonical_weights_and_same_frame() {
        use super::super::gpu_live_test_support::{make_params, owned_arrays};
        use crate::gpu_live::{
            maple_gpu_live_close, maple_gpu_live_open, maple_gpu_live_render,
            maple_gpu_live_scope_snapshot, MapleGpuLiveSession,
        };
        use raw_core::{
            types::{adjustment::AutoExposureMode, WbMethod},
            view::auto_profile::{curve::ProfileCurve, lut::ColorLut},
            xmp::AdjustmentModel,
        };
        let (input, layers) = fixture();
        let model = AdjustmentModel {
            temperature: 6500.0,
            sharpen_amount: 0.0,
            nr_color: 0.0,
            auto_exposure: AutoExposureMode::Off,
            local_adjustments: vec![LocalAdjustment {
                mask: Mask::Everywhere,
                range: Some(SKIN_TONE_RANGE),
                adjustments: PartialAdjustments::default(),
            }],
            ..Default::default()
        };
        let arrays = owned_arrays(&model, &ProfileCurve::identity(), &ColorLut::identity(2));
        let mut gp = make_params(&input, &model, WbMethod::Cat16, 2, &arrays);
        gp.input_shape = 1;
        gp.profile_curve_len = 0;
        gp.residual_lut_size = 0;
        gp.target_primaries = 0;
        gp.scope_enabled = 1;
        gp.scope_layer = 0;
        let mut handle = MapleGpuLiveSession {
            inner: std::ptr::null_mut(),
        };
        unsafe {
            assert_eq!(maple_gpu_live_open(input.as_ptr(), 64, 48, &mut handle), 0);
        }
        let mut before = vec![0u8; 64 * 48 * 3];
        unsafe {
            assert_eq!(maple_gpu_live_render(&handle, &gp, before.as_mut_ptr()), 0);
        }
        let mut cp = default_params();
        cp.temperature = 6500.0;
        cp.decoded_temperature = 6500.0;
        cp.skip_agx = 1;
        cp.local_adjustments_ptr = layers.as_ptr();
        cp.local_adjustments_len = layers.len();
        let mut cpu = vec![0.0; input.len()];
        unsafe {
            assert_eq!(
                maple_apply_chain_scope_rgba_f32(
                    input.as_ptr(),
                    input.len(),
                    64,
                    48,
                    &cp,
                    0,
                    cpu.as_mut_ptr()
                ),
                0
            );
        }
        for region in [(0, 0, 64, 48), (0, 12, 24, 24), (32, 12, 32, 24)] {
            let (w, h, expected) = raw_core::scope::inspection_snapshot::snapshot_scope_rgba(
                &cpu, 64, 48, region, true,
            )
            .unwrap();
            let mut actual = vec![0u8; 512 * 512 * 4];
            let (mut aw, mut ah) = (0, 0);
            let rc = unsafe {
                maple_gpu_live_scope_snapshot(
                    &handle,
                    &gp,
                    region.0,
                    region.1,
                    region.2,
                    region.3,
                    actual.as_mut_ptr(),
                    actual.len(),
                    &mut aw,
                    &mut ah,
                )
            };
            assert_eq!(rc, 0);
            assert_eq!((aw, ah), (w, h));
            actual.truncate((aw * ah * 4) as usize);
            let worst = actual
                .iter()
                .zip(&expected)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(worst <= 1, "CPU/Metal byte difference {worst}");
            let a =
                raw_core::scope::inspection::reduce_scope_evidence(&actual, w, h, true).unwrap();
            let b =
                raw_core::scope::inspection::reduce_scope_evidence(&expected, w, h, true).unwrap();
            assert_eq!(a.sample_count, b.sample_count);
            assert_eq!(a.confidence, b.confidence);
        }
        let mut after = vec![0u8; before.len()];
        unsafe {
            assert_eq!(maple_gpu_live_render(&handle, &gp, after.as_mut_ptr()), 0);
            maple_gpu_live_close(&mut handle);
        }
        assert_eq!(before, after, "inspection must not change rendered pixels");
    }
}
