//! The full frame's dehaze haze maps for a native-detail window (#3287).
//!
//! A windowed chain cannot measure dehaze from its patch, so the host hands it
//! the maps of the frame the patch sits in: `maple_scene_linear_chain_haze_map_f32`
//! runs the per-tick chain up to dehaze on the host's whole-frame decoded
//! buffer (the one the whole-image chain runs on, at its resolution: the prefix does not commute with a downsample) and returns an
//! opaque [`MapleHazeMap`] for the window entries. The last measurement is
//! memoised process-wide, keyed by the frame's content digest and everything
//! upstream of dehaze, so a pan or a dehaze-slider move at 100% does not
//! re-measure.

use std::sync::{Arc, Mutex};

use raw_core::stages::dehaze::{self, FrameHaze};

use crate::error::set_last_error;
use crate::scene_linear_chain::{chain_inputs_from_params, MapleAdjustmentParams};
use crate::scene_linear_chain_curves::{inject_tone_curves, MapleToneCurves};

#[path = "scene_linear_chain_haze_key.rs"]
mod key;
pub use key::maple_scene_linear_chain_haze_key;

/// Opaque haze maps of one frame. Free with [`maple_haze_map_free`].
pub struct MapleHazeMap(pub(crate) Arc<FrameHaze>);

#[derive(PartialEq)]
struct HazeKey {
    digest: u64,
    dims: (u32, u32),
    model: raw_core::xmp::AdjustmentModel,
    decoded: (f32, f32),
    wb_frame: raw_core::stages::wb_camera::SliderFrameExport,
    creative: u64,
    whites_anchor_ev: Option<f32>,
    nr_sampling_scale: f32,
}

static LAST: Mutex<Option<(HazeKey, Arc<FrameHaze>)>> = Mutex::new(None);

/// # Safety
/// `p.creative_ptr` null or valid for the call.
unsafe fn creative_digest(p: &MapleAdjustmentParams) -> u64 {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    if let Some(creative) = p.creative_ptr.as_ref() {
        creative.hash_into(&mut h);
    }
    h.finish()
}

fn digest(frame: &[f32]) -> u64 {
    frame.iter().fold(0xcbf2_9ce4_8422_2325, |h, v| {
        (h ^ u64::from(v.to_bits())).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Measure (or reuse) the haze maps the whole-frame chain would measure for
/// `params` on the f32 RGBA frame at `frame_ptr`. `*out_map` is null, with
/// return code 0, when dehaze is off globally and in every layer.
///
/// # Safety
/// `frame_ptr` must address `width * height * 4` `f32`s; `params` a valid
/// `MapleAdjustmentParams` (its pointers valid); `curves` null or a valid
/// `MapleToneCurves`; `out_map` a writable pointer.
#[no_mangle]
pub unsafe extern "C" fn maple_scene_linear_chain_haze_map_f32(
    frame_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    out_map: *mut *mut MapleHazeMap,
) -> i32 {
    crate::error::catch_panic_rc("maple_scene_linear_chain_haze_map_f32", || {
        if frame_ptr.is_null() || params.is_null() || out_map.is_null() {
            set_last_error("haze map: null pointer".into());
            return 1;
        }
        *out_map = std::ptr::null_mut();
        let Some(lanes) = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .filter(|&n| n > 0)
        else {
            set_last_error(format!("haze map: bad dimension {width}x{height}"));
            return 2;
        };
        let p = &*params;
        let mut ci = match chain_inputs_from_params(p) {
            Ok(ci) => ci,
            Err(e) => {
                set_last_error(e);
                return 8;
            }
        };
        if !curves.is_null() {
            inject_tone_curves(&mut ci.model, &*curves);
        }
        if !dehaze::any_engaged(&ci.model) {
            return 0;
        }
        let frame = std::slice::from_raw_parts(frame_ptr, lanes);
        let options = ci.options(p.skip_agx != 0);
        let key = HazeKey {
            digest: digest(frame),
            dims: (width, height),
            model: dehaze::haze_key(&ci.model),
            decoded: (options.decoded_temp, options.decoded_tint),
            wb_frame: ci.wb_frame,
            creative: creative_digest(p),
            whites_anchor_ev: options.whites_anchor_ev,
            nr_sampling_scale: options.nr_sampling_scale,
        };
        let cached = LAST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|(cached, _)| *cached == key)
            .map(|(_, haze)| Arc::clone(haze));
        if let Some(haze) = cached {
            *out_map = Box::into_raw(Box::new(MapleHazeMap(haze)));
            return 0;
        }
        // Measured outside the lock, so another window's lookup never waits
        // on this measurement.
        let measured = match raw_core::pipeline::scene_linear_chain_haze_map(
            frame, width, height, &ci.model, &options,
        ) {
            Ok(Some(haze)) => Arc::new(haze),
            Ok(None) => return 0,
            Err(e) => {
                set_last_error(format!("haze map: {e}"));
                return 8;
            }
        };
        *LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some((key, Arc::clone(&measured)));
        *out_map = Box::into_raw(Box::new(MapleHazeMap(measured)));
        0
    })
}

/// Free a map from [`maple_scene_linear_chain_haze_map_f32`]. Null is a no-op.
///
/// # Safety
/// `map` must be null or a pointer that entry returned, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn maple_haze_map_free(map: *mut MapleHazeMap) {
    crate::error::catch_panic("maple_haze_map_free", (), || {
        if !map.is_null() {
            drop(Box::from_raw(map));
        }
    })
}
