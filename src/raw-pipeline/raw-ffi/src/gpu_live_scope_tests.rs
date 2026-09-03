//! Vectorscope scope-pass FFI round trip (#3272): `maple_gpu_live_render`
//! writes [`MapleScopeStats`] one tick late when the host asks for it, and
//! never touches a null/absent `scope_out`. Reuses `gpu_live_tests`'
//! `pub(super)` fixtures — same convention as every other sibling test file.
//!
//! Deliberately does NOT cross-check `stats.bins` against a CPU histogram of
//! this test's own u8 render output: the scope pass samples the chain's f32
//! buffer BEFORE dither, by design, so it is MORE precise than the presented
//! pixels, not required to reproduce them exactly. `raw_gpu::live_session`'s
//! own gate (`tests_scope.rs`, `scope_stats_arrive_one_tick_late_and_...`)
//! already cross-checks the real invariant — the stats against a full-
//! precision f32 readback of the exact buffer the scope pass read — with a
//! documented note on why a dithered u8 reconstruction isn't a valid oracle
//! for a chroma histogram (a cluster of pixels near a shared bin boundary in
//! full precision can cross it together after 8-bit quantization, moving a
//! large fraction of total weight with no individual pixel being "wrong").
//! This file only proves what's unique to the FFI layer: struct-field
//! marshalling, the one-tick-late timing, and the null/disabled contract.

use super::gpu_live_tests::{
    make_params, nonidentity_curve, nonidentity_lut, owned_arrays, scene_linear_rgba,
};
use super::*;
use crate::MapleScopeStats;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

#[test]
fn live_render_writes_scope_stats_one_tick_late_when_enabled() {
    let (w, h) = (32u32, 24u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    let rc = unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) };
    assert_eq!(rc, 0, "gpu_live_open rc {rc}");

    let model = AdjustmentModel::default();
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(9);
    let arr = owned_arrays(&model, &curve, &lut);
    let mut params = make_params(&model, WbMethod::Cat16, 9, &arr);
    let mut stats = Box::new(MapleScopeStats {
        frame: 0,
        total: 0,
        _pad: 0,
        bins: [0; 128 * 128],
    });
    params.scope_layer = -1;
    params.scope_enabled = 1;
    params.scope_out = &mut *stats;

    let mut out = vec![0u8; (w * h * 3) as usize];
    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
        0
    );
    assert_eq!(stats.frame, 0, "no sample after the first tick");

    assert_eq!(
        unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
        0
    );
    assert_eq!(stats.frame, 1, "tick-1 sample delivered on tick 2");
    assert!(stats.total > 0);
    let whole: u64 = stats.bins.iter().map(|b| *b as u64).sum();
    assert_eq!(whole, stats.total as u64, "bins must sum to total");

    unsafe { maple_gpu_live_close(&mut handle) };
}

#[test]
fn null_scope_out_is_never_written_and_disabled_scope_is_free() {
    let (w, h) = (16u32, 12u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    assert_eq!(
        unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) },
        0
    );

    let model = AdjustmentModel::default();
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(9);
    let arr = owned_arrays(&model, &curve, &lut);
    let params = make_params(&model, WbMethod::Cat16, 9, &arr); // scope_* left at the disabled default

    let mut out = vec![0u8; (w * h * 3) as usize];
    for _ in 0..2 {
        assert_eq!(
            unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
            0
        );
    }
    unsafe { maple_gpu_live_close(&mut handle) };
}
