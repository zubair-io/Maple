//! Auto Tone WASM surface — one-shot slider recommendation for a post-WB
//! scene-linear buffer, exposed to the Angular `maple-common` package via
//! wasm-bindgen.
//!
//! Phase 1a (this revision): exposure only. The other five slider fields
//! are returned as 0.0 so the JS surface stays stable across phases —
//! Phase 1b/1c fill them in without churning consumers. Mirrors the
//! Apple-side `maple_compute_auto_tone` C-FFI in
//! `raw-ffi/src/auto_tone.rs`.

use raw_core::stages::auto_tone;
use wasm_bindgen::prelude::*;

/// Auto Tone slider recommendation. Mirrors the C-FFI `MapleAutoTone`
/// struct field-for-field so the Apple Swift binding and the Angular
/// TypeScript binding consume the same payload shape — easier to keep the
/// two UIs in sync.
#[wasm_bindgen]
pub struct AutoTone {
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
/// `scene_post_wb_rgba` must be `4 * width * height` f32 lanes laid out as
/// RGBA (the alpha lane is ignored), already in
/// `raw_core::image::ColorSpace::SceneLinearRec2020`. This is the same
/// buffer shape `render_bytes_scene_linear` returns once the caller has
/// unpacked the fp16 lanes to f32.
///
/// Phase 1a populates the `exposure` field only; the remaining five fields
/// are returned as 0.0 (slider rest position).
#[wasm_bindgen]
pub fn compute_auto_tone(scene_post_wb_rgba: &[f32], width: u32, height: u32) -> AutoTone {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midgray_buffer_recommends_zero_exposure() {
        let w = 64usize;
        let h = 64usize;
        let mut rgba = vec![0.0f32; w * h * 4];
        for px in rgba.chunks_exact_mut(4) {
            px[0] = 0.18;
            px[1] = 0.18;
            px[2] = 0.18;
            px[3] = 1.0;
        }
        let t = compute_auto_tone(&rgba, w as u32, h as u32);
        assert!(t.exposure.abs() < 0.05, "got {}", t.exposure);
        assert_eq!(t.contrast, 0.0);
        assert_eq!(t.whites, 0.0);
        assert_eq!(t.blacks, 0.0);
        assert_eq!(t.highlights, 0.0);
        assert_eq!(t.shadows, 0.0);
    }
}
