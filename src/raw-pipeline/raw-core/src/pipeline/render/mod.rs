//! High-level render entry points.
//!
//! Each function here is a thin wrapper around
//! [`develop_scene_linear_from_raw_with_quality`] (or the sized variant)
//! that handles the post-develop packaging: AgX + sRGB encode + u8
//! quantise + EXIF orient for the legacy display-encoded path, or
//! fp16-RGBA packing + EXIF orient for the scene-linear FFI path that
//! hands the buffer off to a CoreImage / WebGL2 view transform.

use super::{
    develop::develop_scene_linear_from_raw_with_quality,
    develop_sized::develop_scene_linear_sized_from_raw_with_quality,
    dump_after,
    fp16::f32_to_f16_bits,
    orient::apply_orientation_f32_rgba,
    stage, RenderQuality,
};
use crate::{
    error::Result,
    image::{apply_orientation, ColorSpace, Image, RawImage},
    stages::{clarity, dehaze, noise_reduction, saturation, sharpen, texture, vibrance},
    view::{agx, encode, look},
    xmp::AdjustmentModel,
};

/// Per spec § 02 filter chain, slice-1 through slice-5 subset:
/// * Highlight reconstruction (§ 3.3a), SceneToneControls (§ 3.6 steps 1-5),
///   Vibrance + Saturation (§ 3.7, Oklab), Clarity + Texture (§ 3.8),
///   Dehaze (§ 3.9), Richardson-Lucy sharpen (§ 3.10, 3-iter, Gaussian PSF),
///   simplified NR (§ 3.11, L-blur + chroma-blur in Oklab).
/// * Crop (§ 3.12) skipped — no slice-5 fixture exercises it; lands with
///   canonical XMP in slice 7.
/// * Tone curves (§ 3.6 steps 6-7, § 3.6b DisplayReferredCurve) deferred to slice 7.
/// * AgX is the Sobotka power-curve approximation (slice-6 retightens).
pub fn render_from_raw(raw: &RawImage, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    render_from_raw_with_quality(raw, model, RenderQuality::Full)
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    // Buffer is in display-linear sRGB primaries here. Gamma encoding
    // happens later in `quantize_u8`. Name reflects that — "srgb_linear",
    // not "post_srgb_encode" which would have implied a full sRGB encode
    // (per PR #281 review feedback).
    dump_after("17_srgb_linear", &scene);
    let mut bytes = stage("quantize_u8", || encode::quantize_u8(&mut scene));
    // DisplayLookCurve (#371) — empirical per-channel u8->u8 LUT that
    // closes ~65% of the bias-to-ACR gap. `Look::Neutral` short-circuits
    // and the buffer is bit-identical to the pre-#371 output.
    stage("look", || look::apply(&mut bytes, model.look));
    // Apply EXIF orientation last — rotating/flipping sRGB u8 is cheap and
    // keeps every upstream stage indifferent to sensor-vs-display framing.
    let (w, h, bytes) = stage("apply_orientation", || apply_orientation(&bytes, scene.width, scene.height, raw.orientation));
    // Both branches return the buffer at its actual rendered dimensions —
    // `Full` matches the sensor, `Preview` is half-res in both axes
    // (because of `demosaic::half_res`), and Apple/Web consumers handle
    // the resolution gap via their lazy display transform (CIImage scale
    // on Apple; texture upload on Web). Pixel-doubling here added ~300 MB
    // of FFI traffic and 4× the allocator pressure on a 100 MP RAW for no
    // extra information.
    Ok((w, h, bytes))
}

/// Scene-linear render entry. Runs the same development chain as
/// `render_from_raw_with_quality` (via the shared
/// `develop_scene_linear_from_raw_with_quality` helper — Step 2.4a)
/// but stops after `nr_color` and packs to fp16 RGBA without the view
/// transform tail. Output is packed Rec.2020 fp16 RGBA (8 bytes/pixel),
/// straight alpha = 1.0, row-major. Returned `Vec<u16>` is the fp16 bit
/// pattern; the FFI hands the underlying bytes to the caller via
/// `bytemuck::cast_slice`.
///
/// Plan 1 (FFI split) — the Apple side imports this buffer as a CIImage
/// tagged extendedLinearITUR_2020 and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage. See
/// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md.
pub fn render_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    // STOP: no agx::apply, no rec2020_to_srgb, no quantize_u8.
    // Pack [f32;3] + alpha=1.0 to packed [f32;4] RGBA, then orient, then
    // convert to fp16 lanes for the FFI handoff.
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_from_raw_with_quality`].
///
/// Same develop chain and orientation handling, but returns the oriented
/// Rec.2020 RGBA buffer as packed `f32` lanes (16 bytes per pixel) instead
/// of fp16. This is the canonical end-to-end shape per #416 — fp16 is
/// kept as a parallel surface until every consumer has migrated.
///
/// `Vec<f32>` length is `4 * width * height`, row-major, straight alpha
/// = 1.0 in every alpha lane. See #482 for the FFI surface that exposes
/// this to the Web consumer (Apple still consumes the fp16 entries today;
/// follow-up ticket tracks the per-tick chain migration that blocks the
/// Apple swap).
pub fn render_scene_linear_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Sized scene-linear render entry. Same shared development chain as
/// `render_scene_linear_from_raw_with_quality`, then downsample to fit
/// within `max_long_edge` (single scalar — see Plan 1 v2 Task 8 API
/// decision: long-edge simplifies WASM parity and aspect math is local
/// to the renderer; per ticket 06 § Open Questions). Never upscales.
///
/// Plan 1 v2 (FFI split + viewport-sized) — the Apple side imports this
/// buffer at the target dimensions and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage.
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    // M3: develop with the early-downsample helper. The downsample
    // happens immediately after demosaic so post-demosaic stages run
    // on the viewport-sized buffer. The post-pipeline
    // `downsample_image_area` call this function used to make is now
    // inside the helper.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_sized_from_raw_with_quality`].
///
/// Same `max_long_edge` cap, no-upscale guarantee, and oriented output.
/// Returns the oriented buffer as packed `f32` lanes. See the f32 variant
/// of the full-size entry for the rationale (#482).
pub fn render_scene_linear_sized_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Synthetic-input render: takes an already-scene-linear `Image` (the kind
/// `synthetic_input::*` produces) and runs ONLY the view transform on it —
/// AgX + Rec.2020→sRGB + u8 quantize. The develop chain (linearize,
/// demosaic, DCP, scene-tone, …) is skipped because the input is already
/// in the working colorspace by construction.
///
/// `MAPLE_STAGE_DUMP` is honoured: stages 16 (`16_agx`) and 17
/// (`17_srgb_linear`) get written exactly like the RAW path, so the
/// detectors in `src/scripts/{banding,hue_stability,halo}_check.py` can
/// load and analyse them without caring whether the input was a real DNG
/// or a synthetic ramp.
///
/// Used by `maple-cli synthetic --kind {neutral-ramp,hue-patch,halo-disk}`.
pub fn render_from_scene_linear(
    image: Image,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = image;
    scene.assert_space(ColorSpace::SceneLinearRec2020);
    // Dump the pre-view-transform buffer too — gives the detectors a
    // way to see exactly what entered AgX. Numbered `00` so it sorts
    // before stages 16/17 in the dump dir.
    dump_after("00_synthetic_input", &scene);
    stage("synth_agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("synth_rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    let mut bytes = stage("synth_quantize_u8", || encode::quantize_u8(&mut scene));
    stage("synth_look", || look::apply(&mut bytes, model.look));
    Ok((w, h, bytes))
}

/// Synthetic-input render with the slider chain applied first. The detectors
/// that probe slider artefacts (halo overshoot from clarity / dehaze /
/// sharpen) need a path that runs those stages on a synthetic input. Mirrors
/// the scene-linear stages that `develop_scene_linear_from_raw_with_quality`
/// runs over real raws, but on a fresh `Image` rather than going through
/// decode / demosaic / DCP / auto-exposure.
///
/// White-balance and scene-tone-controls are skipped — the synthetic input
/// is generated directly in the Rec.2020 working space at a known
/// brightness, so running WB delta or tone-mapping over it would only
/// muddy the artefact under test. Vibrance and saturation are kept (they
/// scale around the achromatic axis, so they're no-ops on neutrals but DO
/// affect saturated primaries the way a real pixel would see). Stage
/// numbering matches the real RAW develop chain in `develop.rs`, with no
/// dumps for the skipped stages (so `05_auto_exposure` / `06_white_balance`
/// / `07_scene_tone_controls` are absent from this trace by design).
pub fn render_from_scene_linear_with_chain(
    image: Image,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = image;
    scene.assert_space(ColorSpace::SceneLinearRec2020);
    dump_after("00_synthetic_input", &scene);
    // White-balance + scene-tone-controls deliberately skipped — see
    // doc-comment. The detectors that consume this trace target slider
    // artefacts (clarity / dehaze / sharpen halos, NR banding); the WB
    // and tone-control stages are tested elsewhere on real RAWs.
    stage("synth_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("synth_saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("synth_clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("synth_texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("synth_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("synth_sharpen", || {
        sharpen::apply(
            &mut scene,
            model.sharpen_amount,
            model.sharpen_radius,
            model.sharpen_detail,
            model.sharpen_masking,
        )
    });
    dump_after("13_sharpen", &scene);
    stage("synth_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("synth_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    stage("synth_agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("synth_rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    let mut bytes = stage("synth_quantize_u8", || encode::quantize_u8(&mut scene));
    stage("synth_look", || look::apply(&mut bytes, model.look));
    Ok((w, h, bytes))
}

// Tests live in the sibling `tests.rs` file so this module stays under
// the 600-LOC budget (#482). Test contents were moved verbatim.
#[cfg(test)]
mod tests;
