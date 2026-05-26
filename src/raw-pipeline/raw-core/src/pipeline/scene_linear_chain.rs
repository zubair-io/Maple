//! Per-tick FFI chain: re-apply the user-tweakable scene-linear stages
//! on top of an already-decoded fp16 RGBA buffer.
//!
//! This is the path the Apple shell (and the Web shell) hits on every
//! slider tick. The expensive decode + DCP + AE work has already run and
//! its result is cached as fp16 RGBA in Rec.2020 — the Rust FFI re-runs
//! only the cheap, model-dependent stages and packs the result back to
//! fp16 RGBA.
//!
//! Stages, in order: `white_balance::apply_delta` → `scene_tone_controls`
//! → `tone_curves` → `vibrance` → `saturation` → `clarity` → `texture` →
//! `dehaze` → `nr_luminance` → `agx` (when `skip_agx == false`).
//!
//! **Deliberately omits** `sharpen` and `nr_color` — those two stay on
//! the Apple GPU path (Metal compute pipelines). See the per-function
//! doc-comment for the rationale.

use super::{
    fp16::{f16_bits_to_f32, f32_to_f16_bits},
    stage,
};
use crate::{error::Result, xmp::AdjustmentModel};

/// Apply the per-tick scene-linear chain to an already-decoded fp16 RGBA
/// scene-linear Rec.2020 buffer.
///
/// Stages, in order: `white_balance::apply_delta` → `scene_tone_controls`
/// → `tone_curves` → `vibrance` → `saturation` → `clarity` → `texture` →
/// `dehaze` → `nr_luminance` → `agx`.
///
/// **Deliberately omits** `sharpen` and `nr_color`. Those two stages are
/// kept on the Apple GPU path (Metal compute pipelines) because:
///   * sharpen at viewport size dominates Rust-on-CPU latency (~33 ms on a
///     2 MP buffer, exceeding the 16 ms slider tick budget); GPU is
///     essential.
///   * nr_color is borderline (~5 ms) but architecturally easier to leave
///     on Metal alongside sharpen than to split the FFI surface.
///
/// `decoded_temp`/`decoded_tint` are the WB the cached buffer was decoded
/// at by the Rust FFI (sidecar `Temperature`/`Tint` fields when an XMP
/// was passed to `decodeSceneLinear`, else 6500/0). The chain applies
/// the **delta** `wb_gains(live) / wb_gains(decoded)` so opening a saved
/// sidecar doesn't double-apply WB. Pass `(6500.0, 0.0)` for the "no
/// sidecar applied at decode" common case.
///
/// `skip_agx` flips off the AgX view transform tail. Set true for the
/// non-RAW input path, where the JPEG / HEIF input already has a tone
/// curve baked in by the camera and applying AgX would double-tone-map.
///
/// Input is parsed as packed fp16 RGBA, row-major, 4 lanes per pixel
/// (`bytes_per_pixel = 8`). Alpha is read but ignored — the output writes
/// alpha=1.0 unconditionally because every stage in the chain operates on
/// straight RGB and `Image::pixels` is `Vec<[f32; 3]>`.
///
/// Output is the same packed fp16 RGBA layout: post-AgX
/// `DisplayLinearRec2020` ([0,1]) when `skip_agx == false`, else still
/// scene-linear `SceneLinearRec2020` (unbounded). The Apple side re-tags
/// the CIImage as `extendedLinearITUR_2020` for the optional sharpen /
/// nr_color Metal kernels to consume, then sRGB-encodes at the
/// `CIContext.createCGImage` boundary.
///
/// Performance notes (per the worktree-agent-a1ee8a4c brief):
/// At 2 MP viewport size, every stage in this chain runs in <2 ms with
/// the exception of dehaze (which short-circuits to a no-op when
/// `model.dehaze == 0`, the default). Whole-chain target: <10 ms.
pub fn apply_scene_linear_chain(
    in_fp16_rgba: &[u16],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    decoded_temp: f32,
    decoded_tint: f32,
    skip_agx: bool,
) -> Result<Vec<u16>> {
    use crate::image::{ColorSpace, Image};
    use crate::stages::{
        clarity, dehaze, local_adjustments, noise_reduction, saturation, scene_tone_controls,
        texture, tone_curves, vibrance, white_balance,
    };
    use crate::view::agx;

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "apply_scene_linear_chain: pixel count overflow: {}x{}",
                width, height
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain: expected input length overflow (RGBA 4-lane multiplier): {}x{}",
            width, height
        ))
    })?;
    if in_fp16_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain: input length {} != width({}) * height({}) * 4 = {}",
            in_fp16_rgba.len(),
            width,
            height,
            expected_len
        )));
    }

    // Decode fp16 RGBA -> Image (Vec<[f32; 3]>, alpha discarded).
    let mut img = stage("ffi_chain_unpack_fp16", || {
        let mut pixels: Vec<[f32; 3]> = Vec::with_capacity(pixel_count);
        for chunk in in_fp16_rgba.chunks_exact(4) {
            let r = f16_bits_to_f32(chunk[0]);
            let g = f16_bits_to_f32(chunk[1]);
            let b = f16_bits_to_f32(chunk[2]);
            pixels.push([r, g, b]);
        }
        Image {
            width,
            height,
            pixels,
            space: ColorSpace::SceneLinearRec2020,
        }
    });

    // Per-stage application — mirrors `develop_scene_linear_from_raw_with_quality`
    // from `pipeline.rs:182-192`, with sharpen + nr_color intentionally
    // omitted. The order MUST match the Rust reference so calibrate_color_pipeline
    // remains the canonical metric.
    //
    // WB is `apply_delta(live, decoded)` so opening a sidecar with a
    // saved temperature doesn't double-apply WB on top of the decoded
    // buffer. Apple-side contract: caller passes `decoded_temp =
    // asShotCCT` (or the saved sidecar's temperature) to mark the
    // "starting" WB the live slider value is relative to. Identity
    // when `live == decoded` — that's the As Shot rendering, where
    // the slider sits at asShotCCT and the data is unshifted.
    stage("ffi_chain_white_balance", || {
        white_balance::apply_delta(&mut img, model.temperature, model.tint, decoded_temp, decoded_tint, model.wb_method)
    });
    stage("ffi_chain_scene_tone_controls", || {
        scene_tone_controls::apply(&mut img, model)
    });
    stage("ffi_chain_tone_curves", || tone_curves::apply(&mut img, model));
    stage("ffi_chain_vibrance", || vibrance::apply(&mut img, model.vibrance));
    stage("ffi_chain_saturation", || {
        saturation::apply(&mut img, model.saturation)
    });
    stage("ffi_chain_clarity", || clarity::apply(&mut img, model.clarity));
    stage("ffi_chain_texture", || texture::apply(&mut img, model.texture));
    stage("ffi_chain_dehaze", || dehaze::apply(&mut img, model.dehaze));
    // Local adjustments (ticket #280). Empty Vec is a bit-identical no-op.
    stage("ffi_chain_local_adjustments", || {
        local_adjustments::apply(&mut img, &model.local_adjustments)
    });
    // sharpen omitted — kept on Metal GPU path (~33 ms at viewport on CPU)
    stage("ffi_chain_nr_luminance", || {
        noise_reduction::apply_luminance(&mut img, model.nr_luminance)
    });
    // nr_color omitted — kept on Metal GPU path alongside sharpen
    if !skip_agx {
        stage("ffi_chain_agx", || agx::apply(&mut img, model.contrast));
    }

    // Pack post-AgX (DisplayLinearRec2020, [0,1]) back to fp16 RGBA.
    let fp16 = stage("ffi_chain_pack_fp16", || {
        let mut v: Vec<u16> = Vec::with_capacity(pixel_count * 4);
        let alpha_one = f32_to_f16_bits(1.0);
        for p in &img.pixels {
            v.push(f32_to_f16_bits(p[0]));
            v.push(f32_to_f16_bits(p[1]));
            v.push(f32_to_f16_bits(p[2]));
            v.push(alpha_one);
        }
        v
    });
    Ok(fp16)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `apply_scene_linear_chain` over a default model is the AgX-only
    /// transform (every other stage short-circuits at default values). On
    /// a flat mid-gray input the output should be a constant non-zero
    /// post-AgX value (no NaN, no negative).
    #[test]
    fn apply_scene_linear_chain_default_model_yields_agx_only() {
        let w = 4u32;
        let h = 4u32;
        let pixels = (w * h) as usize;
        let g = f32_to_f16_bits(0.18);
        let one = f32_to_f16_bits(1.0);
        let mut input: Vec<u16> = Vec::with_capacity(pixels * 4);
        for _ in 0..pixels {
            input.push(g);
            input.push(g);
            input.push(g);
            input.push(one);
        }
        let model = AdjustmentModel::default();
        let out = apply_scene_linear_chain(&input, w, h, &model, 6500.0, 0.0, false)
            .expect("apply_scene_linear_chain default-model");
        assert_eq!(out.len(), input.len());
        let r = f16_bits_to_f32(out[0]);
        let g_out = f16_bits_to_f32(out[1]);
        let b = f16_bits_to_f32(out[2]);
        let a = f16_bits_to_f32(out[3]);
        assert!(r > 0.0 && r < 1.0, "R out of [0,1]: {}", r);
        assert!(g_out > 0.0 && g_out < 1.0, "G out of [0,1]: {}", g_out);
        assert!(b > 0.0 && b < 1.0, "B out of [0,1]: {}", b);
        assert!((a - 1.0).abs() < 1e-3, "alpha must be 1.0: {}", a);
        assert!((r - g_out).abs() < 1e-3, "R != G: {} vs {}", r, g_out);
        assert!((g_out - b).abs() < 1e-3, "G != B: {} vs {}", g_out, b);
    }

    /// `skip_agx` keeps the buffer in scene-linear domain — mid-gray
    /// 0.18 stays 0.18 (modulo fp16 rounding).
    #[test]
    fn apply_scene_linear_chain_skip_agx_preserves_scene_linear() {
        let w = 4u32;
        let h = 4u32;
        let pixels = (w * h) as usize;
        let g = f32_to_f16_bits(0.18);
        let one = f32_to_f16_bits(1.0);
        let mut input: Vec<u16> = Vec::with_capacity(pixels * 4);
        for _ in 0..pixels {
            input.push(g);
            input.push(g);
            input.push(g);
            input.push(one);
        }
        let model = AdjustmentModel::default();
        let out = apply_scene_linear_chain(&input, w, h, &model, 6500.0, 0.0, true)
            .expect("apply_scene_linear_chain skip_agx");
        let r = f16_bits_to_f32(out[0]);
        // Default model = identity for every cheap stage. With skip_agx
        // we expect input ≈ output (modulo fp16 round-trip).
        assert!((r - 0.18).abs() < 0.01,
            "skip_agx default-model should be identity at scene-linear, got R={}", r);
    }

    /// Length mismatch surfaces as a Pipeline error, not a panic.
    #[test]
    fn apply_scene_linear_chain_rejects_size_mismatch() {
        let model = AdjustmentModel::default();
        let bogus_input = vec![0u16; 10];
        let r = apply_scene_linear_chain(&bogus_input, 4, 4, &model, 6500.0, 0.0, false);
        assert!(r.is_err(), "size mismatch must error");
    }

    /// Defense-in-depth: `width * height` and the subsequent `* 4` are both
    /// computed with `checked_mul`, so a width/height pair whose RGBA byte
    /// length overflows `usize` on 64-bit returns a Pipeline error rather
    /// than wrapping to a nonsense buffer size. Pre-existing bug surfaced by
    /// Copilot review on #159.
    #[test]
    fn apply_scene_linear_chain_rgba_length_overflow_errors() {
        let model = AdjustmentModel::default();
        // u32::MAX * u32::MAX as u128 is 0xFFFFFFFE00000001 — this fits in
        // usize on 64-bit (usize::MAX = 0xFFFFFFFFFFFFFFFF). The reliable
        // overflow happens on the next step: `pixel_count * 4` for the RGBA
        // byte length, which the impl also guards with checked_mul.
        let r = apply_scene_linear_chain(&[], u32::MAX, u32::MAX, &model, 6500.0, 0.0, false);
        match r {
            Err(crate::error::Error::Pipeline(msg)) => {
                assert!(
                    msg.contains("overflow"),
                    "expected overflow message, got: {msg}"
                );
            }
            other => panic!("expected Pipeline overflow error, got: {other:?}"),
        }
    }
}
