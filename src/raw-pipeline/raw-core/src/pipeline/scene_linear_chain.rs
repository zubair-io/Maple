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
//! `dehaze` → `local_adjustments` → `vignette` → `nr_luminance` → `agx`
//! → `split_tone` → `grain` (the AgX + display tail runs when
//! `skip_agx == false`).
//!
//! **Deliberately omits** `sharpen` and `nr_color` — those two stay on
//! the Apple GPU path (Metal compute pipelines). See the per-function
//! doc-comment for the rationale.

mod composite;
use composite::{composite_into_f32, composite_into_fp16};

use super::{
    finite_or_zero,
    fp16::{f16_bits_to_f32, f32_to_f16_bits},
    stage,
};
use crate::{error::Result, view::encode::TargetPrimaries, xmp::AdjustmentModel};

/// Apply the per-tick scene-linear chain to an already-decoded fp16 RGBA
/// scene-linear Rec.2020 buffer.
///
/// Stages, in order: `white_balance::apply_delta` → `scene_tone_controls`
/// → `tone_curves` → `vibrance` → `saturation` → `clarity` → `texture` →
/// `dehaze` → `local_adjustments` → `vignette` → `nr_luminance` → `agx`
/// → `split_tone` → `grain` (AgX + the display-linear stages skipped
/// together on the non-RAW path).
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
/// Output is the same packed fp16 RGBA layout. When `skip_agx == false`:
/// - `target_primaries == Srgb` (0, default): `DisplayLinearRec2020` ([0,1]),
///   identical to the pre-#1337 behavior. The caller is responsible for the
///   Rec.2020 → sRGB display encode (e.g. `encode_display_srgb_f32`).
/// - `target_primaries == P3` (1): the chain applies `rec2020_to_display`
///   internally, so the output carries Display P3 primaries
///   (`DisplayLinearP3`, [0,1]). Legacy callers that zero-initialise
///   `target_primaries` always take the `Srgb` branch — bit-identical to
///   the pre-#1337 pipeline.
/// When `skip_agx == true` the output is scene-linear `SceneLinearRec2020`
/// (unbounded) regardless of `target_primaries`.
///
/// Performance notes (per the worktree-agent-a1ee8a4c brief):
/// At 2 MP viewport size, every stage in this chain runs in <2 ms with
/// the exception of dehaze (which short-circuits to a no-op when
/// `model.dehaze == 0`, the default). Whole-chain target: <10 ms.
///
/// `noise_profile` is the per-camera noise profile from the decoded `RawImage`
/// (typically two coefficients per channel in the DNG NoiseLevelFunction model).
/// `None` disables the profile-aware path and falls back to the ISO-based
/// estimate (the pre-#1709 behaviour). When present, passed through to
/// `noise_reduction::apply_luminance` for scene-noise-adaptive NR.
///
/// `iso` is the ISO speed at which the image was captured (`RawImage::iso`),
/// used by `noise_reduction::apply_luminance` together with `noise_profile` to
/// derive the per-channel sigma. Pass `100` when noise profile data is not
/// available (the hardcoded fallback that was in place before this fix).
pub fn apply_scene_linear_chain(
    in_fp16_rgba: &[u16],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    decoded_temp: f32,
    decoded_tint: f32,
    skip_agx: bool,
    target_primaries: TargetPrimaries,
    noise_profile: Option<&[f32]>,
    iso: u32,
) -> Result<Vec<u16>> {
    use crate::image::{ColorSpace, Image};
    use crate::stages::{
        clarity, dehaze, grain, hsl, local_adjustments, noise_reduction, saturation,
        scene_tone_controls, split_tone, texture, tone_curves, vibrance, vignette, white_balance,
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
        white_balance::apply_delta(
            &mut img,
            model.temperature,
            model.tint,
            decoded_temp,
            decoded_tint,
            model.wb_method,
        )
    });
    stage("ffi_chain_scene_tone_controls", || {
        scene_tone_controls::apply(&mut img, model)
    });
    stage("ffi_chain_tone_curves", || {
        tone_curves::apply(&mut img, model)
    });
    stage("ffi_chain_vibrance", || {
        vibrance::apply(&mut img, model.vibrance)
    });
    stage("ffi_chain_saturation", || {
        saturation::apply(&mut img, model.saturation)
    });
    // HSL 8-band (#1112, tone/zoom design § 10.4) — scene-linear Oklab,
    // after saturation, before clarity. All-defaults is a bit-identical no-op
    // (the whole-stage short-circuit in hsl::apply guards this).
    stage("ffi_chain_hsl", || {
        hsl::apply(
            &mut img,
            &[
                model.hue_adjustment_red,
                model.hue_adjustment_orange,
                model.hue_adjustment_yellow,
                model.hue_adjustment_green,
                model.hue_adjustment_aqua,
                model.hue_adjustment_blue,
                model.hue_adjustment_purple,
                model.hue_adjustment_magenta,
            ],
            &[
                model.saturation_adjustment_red,
                model.saturation_adjustment_orange,
                model.saturation_adjustment_yellow,
                model.saturation_adjustment_green,
                model.saturation_adjustment_aqua,
                model.saturation_adjustment_blue,
                model.saturation_adjustment_purple,
                model.saturation_adjustment_magenta,
            ],
            &[
                model.luminance_adjustment_red,
                model.luminance_adjustment_orange,
                model.luminance_adjustment_yellow,
                model.luminance_adjustment_green,
                model.luminance_adjustment_aqua,
                model.luminance_adjustment_blue,
                model.luminance_adjustment_purple,
                model.luminance_adjustment_magenta,
            ],
        )
    });
    stage("ffi_chain_clarity", || {
        clarity::apply(&mut img, model.clarity)
    });
    stage("ffi_chain_texture", || {
        texture::apply(&mut img, model.texture)
    });
    stage("ffi_chain_dehaze", || dehaze::apply(&mut img, model.dehaze));
    // Local adjustments (ticket #280). Empty Vec is a bit-identical no-op.
    stage("ffi_chain_local_adjustments", || {
        local_adjustments::apply(&mut img, &model.local_adjustments)
    });
    // Vignette (#1109) — same chain position as develop (after local
    // adjustments, before the omitted sharpen). Anchored to this buffer's
    // extent — the viewport-sized decode of the DefaultCrop render rect,
    // so the normalized gain field matches the full-res render.
    stage("ffi_chain_vignette", || {
        vignette::apply(&mut img, model.vignette_amount, model.vignette_feather)
    });
    // sharpen omitted — kept on Metal GPU path (~33 ms at viewport on CPU)
    stage("ffi_chain_nr_luminance", || {
        noise_reduction::apply_luminance(&mut img, model.nr_luminance, noise_profile, iso)
    });
    // nr_color omitted — kept on Metal GPU path alongside sharpen
    if !skip_agx {
        stage("ffi_chain_agx", || agx::apply(&mut img, model.contrast));
        // Split toning (#1111) — display-linear Oklab tint, post-AgX,
        // before grain (the canonical render-tail order). Skipped with
        // AgX on the non-RAW path, like every display-domain stage.
        stage("ffi_chain_split_tone", || {
            split_tone::apply(
                &mut img,
                model.split_tone_shadow_hue,
                model.split_tone_shadow_saturation,
                model.split_tone_highlight_hue,
                model.split_tone_highlight_saturation,
                model.split_tone_balance,
            )
        });
        // Film grain (#1110) — display-linear, post-AgX (same position as
        // the canonical render tail). Skipped with AgX on the non-RAW path:
        // the display-domain effects ride the view transform, and the
        // skip_agx buffer never enters DisplayLinearRec2020.
        stage("ffi_chain_grain", || {
            grain::apply(
                &mut img,
                model.grain_amount,
                model.grain_size,
                model.grain_roughness,
            )
        });
        // Display-primary conversion (#1337). Mirrors the GPU chain's
        // `DisplayEncodePass` position (after grain, before sRGB gamma).
        // For `Srgb` (value 0 / the zero-init default) this branch is a
        // no-op — the buffer stays `DisplayLinearRec2020` and the caller
        // applies `rec2020_to_srgb` separately (e.g. via
        // `encode_display_srgb_f32`), preserving bit-identical behavior
        // for every pre-#1337 caller. For `P3` (value 1) the Oklab
        // gamut-compress + sRGB→P3 matrix runs here; the output carries
        // `DisplayLinearP3`.
        if target_primaries != TargetPrimaries::Srgb {
            use crate::view::encode::rec2020_to_display;
            stage("ffi_chain_display_encode", || {
                rec2020_to_display(&mut img, target_primaries)
            });
        }
    }

    // Pack the result back to fp16 RGBA. Tag notes:
    // • skip_agx=true  → SceneLinearRec2020 (unbounded, no display encode)
    // • skip_agx=false, Srgb → DisplayLinearRec2020 (caller handles encode)
    // • skip_agx=false, P3  → DisplayLinearP3 (display encode applied above)
    // `finite_or_zero` scrubs NaN/Inf at the pack endcap (#1088) —
    // `f32_to_f16_bits` preserves NaN by design, and the caller hands
    // these lanes straight to a GPU texture.
    let fp16 = stage("ffi_chain_pack_fp16", || {
        let mut v: Vec<u16> = Vec::with_capacity(pixel_count * 4);
        let alpha_one = f32_to_f16_bits(1.0);
        for p in &img.pixels {
            v.push(f32_to_f16_bits(finite_or_zero(p[0])));
            v.push(f32_to_f16_bits(finite_or_zero(p[1])));
            v.push(f32_to_f16_bits(finite_or_zero(p[2])));
            v.push(alpha_one);
        }
        v
    });
    Ok(fp16)
}

/// f32 sibling of [`apply_scene_linear_chain`]. Same stage order and same
/// model semantics; the input and output buffers are packed f32 RGBA
/// (16 bytes/pixel) instead of fp16. Use this from the f32 FFI wrapper
/// (`maple_apply_scene_linear_chain_f32`) so the per-tick chain doesn't
/// silently round-trip through fp16 when the caller holds the scene
/// buffer as f32 end-to-end (#487 / #482).
///
/// Algorithmically identical to the fp16 sibling — every stage operates
/// on the same `Image { pixels: Vec<[f32; 3]> }` representation. The only
/// difference is the endcap (un)packing: this entry reads four f32 lanes
/// per pixel directly, runs the chain, and writes four f32 lanes per
/// pixel out. Alpha is read but ignored — output writes 1.0
/// unconditionally because every stage operates on straight RGB.
///
/// `target_primaries` follows the same convention as the fp16 sibling:
/// `Srgb` (0) leaves the output in `DisplayLinearRec2020` (bit-identical
/// to pre-#1337); `P3` (1) applies `rec2020_to_display` inside the chain.
///
/// `noise_profile` and `iso` — see [`apply_scene_linear_chain`]; identical
/// semantics for the f32 entry.
pub fn apply_scene_linear_chain_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    decoded_temp: f32,
    decoded_tint: f32,
    skip_agx: bool,
    target_primaries: TargetPrimaries,
    noise_profile: Option<&[f32]>,
    iso: u32,
) -> Result<Vec<f32>> {
    use crate::image::{ColorSpace, Image};
    use crate::stages::{
        clarity, dehaze, grain, hsl, local_adjustments, noise_reduction, saturation,
        scene_tone_controls, split_tone, texture, tone_curves, vibrance, vignette, white_balance,
    };
    use crate::view::agx;

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "apply_scene_linear_chain_f32: pixel count overflow: {}x{}",
                width, height
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain_f32: expected input length overflow (RGBA 4-lane multiplier): {}x{}",
            width, height
        ))
    })?;
    if in_f32_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain_f32: input length {} != width({}) * height({}) * 4 = {}",
            in_f32_rgba.len(),
            width,
            height,
            expected_len
        )));
    }

    // Decode f32 RGBA -> Image (Vec<[f32; 3]>, alpha discarded).
    let mut img = stage("ffi_chain_unpack_f32", || {
        let mut pixels: Vec<[f32; 3]> = Vec::with_capacity(pixel_count);
        for chunk in in_f32_rgba.chunks_exact(4) {
            pixels.push([chunk[0], chunk[1], chunk[2]]);
        }
        Image {
            width,
            height,
            pixels,
            space: ColorSpace::SceneLinearRec2020,
        }
    });

    // Per-stage application — mirrors `apply_scene_linear_chain` (fp16
    // sibling) verbatim. The order MUST match the Rust reference so
    // `calibrate_color_pipeline` remains the canonical metric.
    stage("ffi_chain_white_balance", || {
        white_balance::apply_delta(
            &mut img,
            model.temperature,
            model.tint,
            decoded_temp,
            decoded_tint,
            model.wb_method,
        )
    });
    stage("ffi_chain_scene_tone_controls", || {
        scene_tone_controls::apply(&mut img, model)
    });
    stage("ffi_chain_tone_curves", || {
        tone_curves::apply(&mut img, model)
    });
    stage("ffi_chain_vibrance", || {
        vibrance::apply(&mut img, model.vibrance)
    });
    stage("ffi_chain_saturation", || {
        saturation::apply(&mut img, model.saturation)
    });
    // HSL 8-band (#1112) — same position as the fp16 sibling.
    stage("ffi_chain_hsl", || {
        hsl::apply(
            &mut img,
            &[
                model.hue_adjustment_red,
                model.hue_adjustment_orange,
                model.hue_adjustment_yellow,
                model.hue_adjustment_green,
                model.hue_adjustment_aqua,
                model.hue_adjustment_blue,
                model.hue_adjustment_purple,
                model.hue_adjustment_magenta,
            ],
            &[
                model.saturation_adjustment_red,
                model.saturation_adjustment_orange,
                model.saturation_adjustment_yellow,
                model.saturation_adjustment_green,
                model.saturation_adjustment_aqua,
                model.saturation_adjustment_blue,
                model.saturation_adjustment_purple,
                model.saturation_adjustment_magenta,
            ],
            &[
                model.luminance_adjustment_red,
                model.luminance_adjustment_orange,
                model.luminance_adjustment_yellow,
                model.luminance_adjustment_green,
                model.luminance_adjustment_aqua,
                model.luminance_adjustment_blue,
                model.luminance_adjustment_purple,
                model.luminance_adjustment_magenta,
            ],
        )
    });
    stage("ffi_chain_clarity", || {
        clarity::apply(&mut img, model.clarity)
    });
    stage("ffi_chain_texture", || {
        texture::apply(&mut img, model.texture)
    });
    stage("ffi_chain_dehaze", || dehaze::apply(&mut img, model.dehaze));
    stage("ffi_chain_local_adjustments", || {
        local_adjustments::apply(&mut img, &model.local_adjustments)
    });
    // Vignette (#1109) — same chain position as develop / the fp16 sibling.
    stage("ffi_chain_vignette", || {
        vignette::apply(&mut img, model.vignette_amount, model.vignette_feather)
    });
    // sharpen omitted — kept on Metal GPU path (~33 ms at viewport on CPU)
    stage("ffi_chain_nr_luminance", || {
        noise_reduction::apply_luminance(&mut img, model.nr_luminance, noise_profile, iso)
    });
    // nr_color omitted — kept on Metal GPU path alongside sharpen
    if !skip_agx {
        stage("ffi_chain_agx", || agx::apply(&mut img, model.contrast));
        // Split toning (#1111) + film grain (#1110) — see the fp16 sibling.
        stage("ffi_chain_split_tone", || {
            split_tone::apply(
                &mut img,
                model.split_tone_shadow_hue,
                model.split_tone_shadow_saturation,
                model.split_tone_highlight_hue,
                model.split_tone_highlight_saturation,
                model.split_tone_balance,
            )
        });
        stage("ffi_chain_grain", || {
            grain::apply(
                &mut img,
                model.grain_amount,
                model.grain_size,
                model.grain_roughness,
            )
        });
        // Display-primary conversion (#1337) — see the fp16 sibling for the
        // full rationale. `Srgb` is a no-op; `P3` applies rec2020_to_display.
        if target_primaries != TargetPrimaries::Srgb {
            use crate::view::encode::rec2020_to_display;
            stage("ffi_chain_display_encode", || {
                rec2020_to_display(&mut img, target_primaries)
            });
        }
    }

    // Pack the result back to f32 RGBA.
    // Alpha is always 1.0 — see fp16 sibling's contract. `finite_or_zero`
    // scrubs NaN/Inf at the pack endcap (#1088).
    let out = stage("ffi_chain_pack_f32", || {
        let mut v: Vec<f32> = Vec::with_capacity(pixel_count * 4);
        for p in &img.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    Ok(out)
}

/// Patch-compositing wrappers ([`apply_scene_linear_chain_with_patches`],
/// [`apply_scene_linear_chain_f32_with_patches`]) live in a sibling
/// submodule for the file-size budget; re-exported so public paths are
/// unchanged.
mod patches;
pub use patches::{
    apply_scene_linear_chain_f32_with_patches, apply_scene_linear_chain_with_patches,
};

/// Canonical display encode (#877). Split into a sibling submodule for the
/// file-size budget; re-exported here so the public path
/// `pipeline::scene_linear_chain::encode_display_srgb_f32` (and the
/// `pipeline::encode_display_srgb_f32` re-export in `mod.rs`) is unchanged.
mod encode_display;
pub use encode_display::encode_display_srgb_f32;

/// Unit tests split into a submodule to stay under the 600-LOC file
/// budget (#1181).
#[cfg(test)]
mod tests;
