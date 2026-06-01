//! Auto Tone WASM wrapper — one-shot slider recommendation for a post-WB
//! scene-linear buffer, mirrored from `raw_core::stages::auto_tone`.
//!
//! Used by `maple-common`'s `AutoToneService` (added under #A3 — Task A2
//! only ships the WASM surface). Phase 1a populates `exposure`; the other
//! five fields are returned as `0.0` until Phases 1b/1c expand the mapping.
//!
//! The struct shape matches the C `MapleAutoTone` in `raw-ffi/src/auto_tone.rs`
//! so Swift and TypeScript see the same schema across the two bridges.

use raw_core::stages::auto_tone;
use wasm_bindgen::prelude::*;

/// Maple Auto Tone result, JS-visible. Field types are `f32` per the
/// underlying Rust struct; wasm-bindgen exposes them as JS `number`s
/// through generated getters. The plain-`pub` fields work because every
/// member is `Copy` — wasm-bindgen synthesises getters/setters for each.
#[wasm_bindgen]
pub struct AutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

/// Compute Auto Tone values from a post-WB scene-linear RGBA f32 buffer.
///
/// `scene_post_wb_rgba` must be a tightly packed RGBA f32 buffer of length
/// `4 * width * height`, in scene-linear Rec.2020 D65 (the working space
/// the post-WB stage emits). Alpha is ignored. When the slice is shorter
/// than `4 * width * height` the function returns the identity recommendation
/// (all zeros) rather than panicking — same behaviour as the underlying
/// `compute_auto_tone_from_rgba` core adapter.
///
/// Phase 1a: only `exposure` is meaningful; the other five fields are
/// returned as `0.0` until Phase 1b/1c expand the mapping.
#[wasm_bindgen]
pub fn compute_auto_tone(
    scene_post_wb_rgba: &[f32],
    width: u32,
    height: u32,
) -> AutoTone {
    let r = auto_tone::compute_auto_tone_from_rgba(
        scene_post_wb_rgba,
        width as usize,
        height as usize,
        0.005,
    );
    AutoTone {
        exposure: r.exposure,
        contrast: r.contrast,
        whites: r.whites,
        blacks: r.blacks,
        highlights: r.highlights,
        shadows: r.shadows,
    }
}
