//! Scope readback delivery under the APP's cadence (#3387): a canvas-sized
//! session presented repeatedly ~100 ms apart, the way a discrete edit plus
//! its priming ticks arrive from the Apple shell. The existing scope test
//! presents back-to-back on 32×24 and sees "frame 1 on tick 2"; this asks
//! whether a current sample ever lands when frames are big and ticks are
//! spaced, and prints exactly which tick delivered which frame.

use super::gpu_live_tests::{
    make_params, nonidentity_curve, nonidentity_lut, owned_arrays, scene_linear_rgba,
};
use super::*;
use crate::MapleScopeStats;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

fn run(w: u32, h: u32, gap_ms: u64, ticks: usize) -> Vec<u64> {
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
    let mut params = make_params(&model, WbMethod::Cat16, 9, &arr);
    let mut bins = vec![0u32; 128 * 128];
    let mut stats = MapleScopeStats {
        frame: 0,
        total: 0,
        _pad: 0,
        bins_ptr: bins.as_mut_ptr(),
        bins_len: bins.len() as u32,
    };
    params.scope_layer = -1;
    params.scope_enabled = 1;
    params.scope_out = &mut stats;
    let mut out = vec![0u8; (w * h * 3) as usize];
    let mut frames = Vec::new();
    for tick in 1..=ticks {
        assert_eq!(
            unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) },
            0
        );
        eprintln!(
            "SCOPE-TIMING {w}x{h} gap={gap_ms}ms tick {tick}: stats.frame = {}",
            stats.frame
        );
        frames.push(stats.frame);
        std::thread::sleep(std::time::Duration::from_millis(gap_ms));
    }
    unsafe { maple_gpu_live_close(&mut handle) };
    frames
}

/// Back-to-back on a tiny buffer — the contract the existing test pins.
#[test]
fn small_backtoback_delivers_every_frame_one_late() {
    let f = run(32, 24, 0, 5);
    assert_eq!(
        f,
        vec![0, 1, 2, 3, 4],
        "tiny buffer, no gap: tick N shows frame N-1"
    );
}

/// The app's cadence on a canvas-sized buffer. The frame must keep
/// advancing — if it sticks, priming ticks can never carry an edit's own
/// sample and the HUD stays one edit behind forever.
#[test]
fn canvas_sized_spaced_presents_keep_delivering() {
    let f = run(2466, 1850, 100, 6);
    let advancing = f.windows(2).filter(|p| p[1] > p[0]).count();
    assert!(
        advancing >= 4,
        "scope frame stalled under the app's cadence: {f:?} — samples are being dropped"
    );
}
