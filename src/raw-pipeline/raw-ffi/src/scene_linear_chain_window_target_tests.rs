//! #5169: Apple's 100% patch goes through the windowed target entry. A patch
//! carrying the reported reach must render its interior exactly like the
//! same pixels of the full-frame target entry, the S/H mask included.

use crate::error::maple_last_error;
use crate::scene_linear_chain::MapleAdjustmentParams;
use crate::scene_linear_chain_curves::MapleChainWindow;
use crate::scene_linear_chain_curves_target::{
    maple_apply_chain_and_encode_display_target_curves_f32,
    maple_apply_chain_and_encode_display_target_window_f32,
    maple_scene_linear_chain_window_reach_px,
};
use crate::scene_linear_chain_haze::{maple_haze_map_free, maple_scene_linear_chain_haze_map_f32};
use crate::scene_linear_chain_tests::default_params;
use crate::MapleHazeMap;
use std::ffi::CStr;

/// The haze-map memo is process-wide; tests that read it hold this.
static HAZE_MEMO: std::sync::Mutex<()> = std::sync::Mutex::new(());

const FULL_W: u32 = 960;
const FULL_H: u32 = 640;
const PATCH: (u32, u32, u32, u32) = (300, 220, 128, 96);

fn textured_frame() -> Vec<f32> {
    (0..FULL_W * FULL_H)
        .flat_map(|i| {
            let (x, y) = ((i % FULL_W) as f32, (i / FULL_W) as f32);
            let sky = if y < 0.4 * FULL_H as f32 { 1.6 } else { 0.06 };
            let block = if (x / 37.0).floor() as i32 % 3 == 0 {
                0.5
            } else {
                1.0
            };
            let ripple = 0.08 * ((x * 0.31).sin() * (y * 0.17).cos());
            let v = (sky * block + ripple).max(0.002);
            [v * 1.05, v, v * 0.82, 1.0]
        })
        .collect()
}

fn params(highlights: f32, shadows: f32, clarity: f32) -> MapleAdjustmentParams {
    MapleAdjustmentParams {
        highlights,
        shadows,
        clarity,
        skip_agx: 0,
        whites_anchor_ev: 0.0,
        ..default_params()
    }
}

fn window(x: u32, y: u32) -> MapleChainWindow {
    MapleChainWindow {
        x,
        y,
        full_width: FULL_W,
        full_height: FULL_H,
    }
}

unsafe fn full_frame(p: &MapleAdjustmentParams, target: u32) -> Vec<f32> {
    let input = textured_frame();
    let mut out = vec![0.0f32; input.len()];
    let rc = maple_apply_chain_and_encode_display_target_curves_f32(
        input.as_ptr(),
        FULL_W,
        FULL_H,
        p,
        std::ptr::null(),
        target,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0, "{:?}", CStr::from_ptr(maple_last_error()));
    out
}

/// Develops the patch the way Apple does: grown by the reported reach,
/// clamped to the frame, run through the windowed entry, interior returned.
unsafe fn windowed_patch(p: &MapleAdjustmentParams, target: u32) -> (u32, Vec<f32>) {
    windowed_patch_with(p, target, std::ptr::null())
}

unsafe fn windowed_patch_with(
    p: &MapleAdjustmentParams,
    target: u32,
    haze: *const MapleHazeMap,
) -> (u32, Vec<f32>) {
    let (px, py, pw, ph) = PATCH;
    let reach = maple_scene_linear_chain_window_reach_px(p, &window(0, 0));
    let (x0, y0) = (px.saturating_sub(reach), py.saturating_sub(reach));
    let (x1, y1) = ((px + pw + reach).min(FULL_W), (py + ph + reach).min(FULL_H));
    let (w, h) = (x1 - x0, y1 - y0);
    let frame = textured_frame();
    let input: Vec<f32> = (y0..y1)
        .flat_map(|y| {
            let start = ((y * FULL_W + x0) * 4) as usize;
            frame[start..start + (w * 4) as usize].to_vec()
        })
        .collect();
    let mut out = vec![0.0f32; input.len()];
    let rc = maple_apply_chain_and_encode_display_target_window_f32(
        input.as_ptr(),
        w,
        h,
        p,
        std::ptr::null(),
        target,
        &window(x0, y0),
        haze,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0, "{:?}", CStr::from_ptr(maple_last_error()));
    let interior = (0..ph)
        .flat_map(|row| {
            let start = (((py - y0 + row) * w + px - x0) * 4) as usize;
            out[start..start + (pw * 4) as usize].to_vec()
        })
        .collect();
    (reach, interior)
}

fn full_interior(full: &[f32]) -> Vec<f32> {
    let (px, py, pw, ph) = PATCH;
    (0..ph)
        .flat_map(|row| {
            let start = (((py + row) * FULL_W + px) * 4) as usize;
            full[start..start + (pw * 4) as usize].to_vec()
        })
        .collect()
}

fn max_abs(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

#[test]
fn reach_covers_both_frame_scaled_sh_passes_and_clarity() {
    let reach = |p: &MapleAdjustmentParams| unsafe {
        maple_scene_linear_chain_window_reach_px(p, &window(0, 0))
    };
    // σ = 15 px · 960/2000 → blur radius round(3σ) = 22 per engaged pass.
    assert_eq!(reach(&params(0.0, 0.0, 0.0)), 0);
    assert_eq!(reach(&params(-60.0, 0.0, 0.0)), 22);
    assert_eq!(reach(&params(-60.0, 60.0, 0.0)), 44);
    assert_eq!(reach(&params(-60.0, 60.0, 60.0)), 84);
    assert_eq!(
        unsafe { maple_scene_linear_chain_window_reach_px(std::ptr::null(), &window(0, 0)) },
        0
    );
}

#[test]
fn windowed_patch_matches_the_full_frame_for_sh_and_clarity() {
    for (name, p) in [
        ("S/H", params(-60.0, 60.0, 0.0)),
        ("clarity", params(0.0, 0.0, 60.0)),
        ("S/H + clarity", params(-60.0, 60.0, 60.0)),
    ] {
        for target in [0, 1] {
            let full = full_interior(&unsafe { full_frame(&p, target) });
            let neutral = full_interior(&unsafe { full_frame(&params(0.0, 0.0, 0.0), target) });
            let (reach, patch) = unsafe { windowed_patch(&p, target) };
            assert!(reach > 0);
            assert!(
                max_abs(&full, &neutral) > 1e-2,
                "{name}: the case must move the render"
            );
            let diff = max_abs(&full, &patch);
            assert!(
                diff <= 1e-4,
                "{name} target {target}: patch differs by {diff}"
            );
        }
    }
}

#[test]
fn a_patch_without_the_reach_shows_why_it_is_needed() {
    let p = params(-60.0, 60.0, 0.0);
    let full = full_interior(&unsafe { full_frame(&p, 0) });
    let (px, py, pw, ph) = PATCH;
    let input: Vec<f32> = {
        let frame = textured_frame();
        (py..py + ph)
            .flat_map(|y| {
                let start = ((y * FULL_W + px) * 4) as usize;
                frame[start..start + (pw * 4) as usize].to_vec()
            })
            .collect()
    };
    let mut out = vec![0.0f32; input.len()];
    let rc = unsafe {
        maple_apply_chain_and_encode_display_target_window_f32(
            input.as_ptr(),
            pw,
            ph,
            &p,
            std::ptr::null(),
            0,
            &window(px, py),
            std::ptr::null(),
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0);
    assert!(max_abs(&full, &out) > 1e-3);
}

/// #3287: with the frame's haze maps the windowed entry renders dehaze —
/// global and per mask — exactly as the full-frame entry does.
#[test]
fn a_dehaze_patch_with_the_frame_map_matches_the_full_frame() {
    let _memo = HAZE_MEMO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let layer = raw_core::types::LocalAdjustment::radial(
        raw_core::types::Point2::new(0.35, 0.4),
        raw_core::types::Point2::new(0.3, 0.3),
        raw_core::types::PartialAdjustments {
            dehaze: Some(-35.0),
            ..Default::default()
        },
    );
    let local = raw_core::types::local_adjustment::flat::layers_to_flat(&[layer]);
    let p = MapleAdjustmentParams {
        dehaze: 45.0,
        local_adjustments_ptr: local.as_ptr(),
        local_adjustments_len: local.len(),
        ..params(-40.0, 0.0, 30.0)
    };
    let frame = textured_frame();
    let mut haze: *mut MapleHazeMap = std::ptr::null_mut();
    let rc = unsafe {
        maple_scene_linear_chain_haze_map_f32(
            frame.as_ptr(),
            FULL_W,
            FULL_H,
            &p,
            std::ptr::null(),
            &mut haze,
        )
    };
    assert_eq!(rc, 0);
    assert!(!haze.is_null());
    let mut again: *mut MapleHazeMap = std::ptr::null_mut();
    let rc = unsafe {
        maple_scene_linear_chain_haze_map_f32(
            frame.as_ptr(),
            FULL_W,
            FULL_H,
            &MapleAdjustmentParams { dehaze: 80.0, ..p },
            std::ptr::null(),
            &mut again,
        )
    };
    assert_eq!(rc, 0);
    // The per-mask map depends on the global amount, so a global move with a
    // dehaze layer measures again; without the layer it would be reused.
    assert!(!std::sync::Arc::ptr_eq(unsafe { &(*haze).0 }, unsafe {
        &(*again).0
    }));
    unsafe { maple_haze_map_free(again) };
    let full = full_interior(&unsafe { full_frame(&p, 0) });
    let (_, patch) = unsafe { windowed_patch_with(&p, 0, haze) };
    unsafe { maple_haze_map_free(haze) };
    let diff = max_abs(&full, &patch);
    assert!(diff <= 1e-4, "dehaze patch differs by {diff}");
}

#[test]
fn a_global_dehaze_move_reuses_the_frame_map() {
    let _memo = HAZE_MEMO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let p = MapleAdjustmentParams {
        dehaze: 30.0,
        ..params(0.0, 0.0, 0.0)
    };
    let frame = textured_frame();
    let measure = |p: &MapleAdjustmentParams| unsafe {
        let mut haze: *mut MapleHazeMap = std::ptr::null_mut();
        let rc = maple_scene_linear_chain_haze_map_f32(
            frame.as_ptr(),
            FULL_W,
            FULL_H,
            p,
            std::ptr::null(),
            &mut haze,
        );
        assert_eq!(rc, 0);
        haze
    };
    let (first, second) = (
        measure(&p),
        measure(&MapleAdjustmentParams { dehaze: -60.0, ..p }),
    );
    assert!(std::sync::Arc::ptr_eq(unsafe { &(*first).0 }, unsafe {
        &(*second).0
    }));
    unsafe {
        maple_haze_map_free(first);
        maple_haze_map_free(second);
    }
    let off = measure(&params(0.0, 0.0, 0.0));
    assert!(off.is_null(), "no dehaze, no map");
}

#[test]
fn dehaze_without_a_map_and_a_null_window_are_refused() {
    let input = textured_frame();
    let mut out = vec![0.0f32; input.len()];
    let p = MapleAdjustmentParams {
        dehaze: 40.0,
        ..params(0.0, 0.0, 0.0)
    };
    let refused = |p: &MapleAdjustmentParams, w: *const MapleChainWindow, out: &mut [f32]| unsafe {
        maple_apply_chain_and_encode_display_target_window_f32(
            input.as_ptr(),
            FULL_W,
            FULL_H,
            p,
            std::ptr::null(),
            0,
            w,
            std::ptr::null(),
            out.as_mut_ptr(),
        )
    };
    assert_eq!(refused(&p, &window(0, 0), &mut out), 8);
    let msg = unsafe { CStr::from_ptr(maple_last_error()) }.to_string_lossy();
    assert!(msg.contains("dehaze"), "{msg}");
    assert_eq!(
        refused(&params(0.0, 0.0, 0.0), std::ptr::null(), &mut out),
        1
    );
}

#[test]
fn the_haze_key_digest_ignores_amounts_and_stages_no_map_depends_on() {
    use crate::scene_linear_chain_haze::maple_scene_linear_chain_haze_key;
    let key = |p: &MapleAdjustmentParams| unsafe {
        maple_scene_linear_chain_haze_key(p, std::ptr::null())
    };
    let base = MapleAdjustmentParams {
        dehaze: 30.0,
        ..params(0.0, 0.0, 0.0)
    };
    assert_eq!(key(&params(0.0, 0.0, 0.0)), 0, "no dehaze, no key");
    assert_ne!(key(&base), 0);
    assert_eq!(
        key(&base),
        key(&MapleAdjustmentParams {
            dehaze: -70.0,
            ..base
        })
    );
    assert_eq!(
        key(&base),
        key(&MapleAdjustmentParams {
            sharpen_amount: 90.0,
            ..base
        })
    );
    assert_ne!(
        key(&base),
        key(&MapleAdjustmentParams {
            exposure: 0.7,
            ..base
        })
    );
    let (cold, warm) = ([0.5f32; 8], [0.25f32; 8]);
    let with_wire = |wire: &[f32]| MapleAdjustmentParams {
        wb_hsm_ptr: wire.as_ptr(),
        wb_hsm_len: wire.len(),
        wb_hsm_as_shot_cct: 5000.0,
        ..base
    };
    assert_ne!(
        key(&with_wire(&cold)),
        key(&with_wire(&warm)),
        "the HueSatMap the WB stage re-lerps sits upstream of every map"
    );
}

/// An empty frame is refused with an error, never a panic or a divide by zero.
#[test]
fn an_empty_frame_has_no_haze_map() {
    let _memo = HAZE_MEMO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let p = MapleAdjustmentParams {
        dehaze: 40.0,
        ..params(0.0, 0.0, 0.0)
    };
    let frame = [0.5f32; 4];
    for (w, h) in [(0, 7), (7, 0), (0, 0)] {
        let mut map = std::ptr::null_mut();
        let rc = unsafe {
            maple_scene_linear_chain_haze_map_f32(
                frame.as_ptr(),
                w,
                h,
                &p,
                std::ptr::null(),
                &mut map,
            )
        };
        assert_eq!(rc, 2, "{w}x{h}");
        assert!(map.is_null());
    }
}
