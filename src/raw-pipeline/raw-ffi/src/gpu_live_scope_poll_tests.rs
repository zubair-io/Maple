use super::scope_poll::maple_gpu_live_poll_scope;
use super::{
    gpu_live_tests::{
        make_params, nonidentity_curve, nonidentity_lut, owned_arrays, scene_linear_rgba,
    },
    *,
};
use crate::MapleScopeStats;
use raw_core::{types::WbMethod, AdjustmentModel};

#[test]
fn scope_poll_copies_final_frame_and_leaves_outputs_unchanged_when_busy_or_empty() {
    let (w, h) = (32u32, 24u32);
    let pixels = scene_linear_rgba(w as usize, h as usize);
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    let mut bins = vec![0u32; 128 * 128];
    let mut rgb = vec![0u8; 512 * 512 * 3];
    let mut stats = MapleScopeStats {
        frame: 77,
        total: 0,
        _pad: 0,
        bins_ptr: bins.as_mut_ptr(),
        bins_len: bins.len() as u32,
        snapshot_width: 0,
        snapshot_height: 0,
        snapshot_len: rgb.len() as u32,
        snapshot_ptr: rgb.as_mut_ptr(),
    };
    unsafe {
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), -1);
        assert_eq!(maple_gpu_live_open(pixels.as_ptr(), w, h, &mut handle), 0);
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), 0);
        assert_eq!(stats.frame, 77);
        {
            let _busy = lock_shared();
            assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), 0);
            assert_eq!(stats.frame, 77);
        }
        stats.snapshot_len = 1;
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), -2);
        stats.snapshot_len = rgb.len() as u32;
        let model = AdjustmentModel::default();
        let curve = nonidentity_curve();
        let lut = nonidentity_lut(9);
        let arrays = owned_arrays(&model, &curve, &lut);
        let mut params = make_params(&pixels, &model, WbMethod::Cat16, 9, &arrays);
        params.scope_enabled = 1;
        params.scope_layer = -1;
        let mut surface = vec![0u8; (w * h * 3) as usize];
        assert_eq!(
            maple_gpu_live_render(&handle, &params, surface.as_mut_ptr()),
            0
        );
        // The bitmap path completed GPU work, but the legacy scope writer
        // reads only the previous slot. The new poll must return this final one.
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), 1);
        assert_eq!(stats.frame, 1);
        assert_eq!((stats.snapshot_width, stats.snapshot_height), (w, h));
        assert_eq!(
            bins.iter().map(|b| u64::from(*b)).sum::<u64>(),
            u64::from(stats.total)
        );
        assert!(rgb[..surface.len()]
            .iter()
            .zip(&surface)
            .all(|(a, b)| a.abs_diff(*b) <= 2));
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), 0);
        assert_eq!(stats.frame, 1);
        maple_gpu_live_close(&mut handle);
        assert_eq!(maple_gpu_live_poll_scope(&handle, &mut stats), -1);
    }
}
