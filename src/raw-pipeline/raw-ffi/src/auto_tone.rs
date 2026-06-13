//! Auto Tone FFI — one-shot slider recommendation for a post-WB
//! scene-linear buffer.
//!
//! Phase 1a (this revision): exposure only. The other five slider fields
//! are returned as 0.0 so the FFI surface stays stable across phases —
//! Phase 1b/1c fill them in without churning consumers. See the design
//! note in `raw-core/src/stages/auto_tone.rs` and spec
//! `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`.

use raw_core::stages::auto_tone;

/// FFI return type for [`maple_compute_auto_tone`]. Plain C struct so the
/// Apple Swift binding (`MapleCore`) and any other native consumer can
/// mirror it 1:1 — slider rest position is encoded as the literal `0.0`,
/// no `Option` plumbing required.
#[repr(C)]
pub struct MapleAutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

/// Compute Auto Tone slider values from a post-WB scene-linear RGBA f32
/// buffer.
///
/// `scene_post_wb_rgba` must point to at least `4 * width * height` f32
/// lanes laid out as RGBA (the alpha lane is ignored). The buffer must
/// already be in `raw_core::image::ColorSpace::SceneLinearRec2020` — the
/// same colorspace produced by `maple_render_scene_linear_*_f32`.
///
/// Phase 1a populates the `exposure` field only; the remaining five
/// fields are returned as 0.0 (slider rest position) so consumers can
/// write the recommendation back to their slider model with a single
/// memcpy.
///
/// Returns:
/// - `0` on success — `*out` is populated.
/// - `-1` on a null pointer, a `width * height` overflow, or a
///   `width * height * 4` overflow.
///
/// # Safety
/// - `scene_post_wb_rgba` must point to at least `4 * width * height` f32
///   values that remain valid for the duration of the call.
/// - `out` must point to a writable `MapleAutoTone`.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_auto_tone(
    scene_post_wb_rgba: *const f32,
    width: u32,
    height: u32,
    out: *mut MapleAutoTone,
) -> i32 {
    if scene_post_wb_rgba.is_null() || out.is_null() {
        return -1;
    }
    let pixels = match (width as usize).checked_mul(height as usize) {
        Some(p) => p,
        None => return -1,
    };
    let len = match pixels.checked_mul(4) {
        Some(l) => l,
        None => return -1,
    };
    let slice = std::slice::from_raw_parts(scene_post_wb_rgba, len);
    let result =
        auto_tone::compute_auto_tone_from_rgba(slice, width as usize, height as usize, 0.005);
    *out = MapleAutoTone {
        exposure: result.exposure,
        contrast: result.contrast,
        whites: result.whites,
        blacks: result.blacks,
        highlights: result.highlights,
        shadows: result.shadows,
    };
    0
}
