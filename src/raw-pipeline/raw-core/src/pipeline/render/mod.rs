//! High-level render entry points.
//!
//! Each function here is a thin wrapper around
//! [`develop_scene_linear_from_raw_with_quality`] (or the sized variant)
//! that handles the post-develop packaging: AgX + sRGB encode + u8
//! quantise + EXIF orient for the legacy display-encoded path, or
//! fp16-RGBA packing + EXIF orient for the scene-linear FFI path that
//! hands the buffer off to a CoreImage / WebGL2 view transform.

use std::path::Path;

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
    types::adjustment::{AutoExposureMode, Profile},
    view::{agx, auto_profile, encode, look},
    xmp::AdjustmentModel,
};

/// Source of the RAW bytes for stages that need pre-decoded access to
/// the file (currently only Auto Profile's embedded-JPEG extraction).
/// CLI / Apple FFI / tests use [`RawInput::Path`]; `raw-wasm` uses
/// [`RawInput::Bytes`] because the browser only ever has the RAW in
/// memory.
///
/// `Bytes::ext` is the file extension (e.g. `"dng"`, `"cr2"`, `"arw"`)
/// passed to `rawler::RawSource` as a `with_path("rawfile.<ext>")` hint.
/// Without it, format disambiguation falls back to magic-byte sniffing,
/// which is ambiguous for some formats (matching the pattern in
/// `decode.rs` and `api.rs`). Pass `""` if unknown — rawler will sniff.
#[derive(Clone, Copy, Debug)]
pub enum RawInput<'a> {
    Path(&'a Path),
    Bytes { bytes: &'a [u8], ext: &'a str },
}

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
    render_from_raw_with_quality_and_source(raw, model, RenderQuality::Full, None)
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    render_from_raw_with_quality_and_source(raw, model, quality, None)
}

/// Render entry that carries the RAW source through to the view
/// transform — required by `Profile::Auto` (Auto Profile Phase 1, #537),
/// which reads the embedded JPEG preview to fit a per-image tone curve.
///
/// `raw_source` is `Option<RawInput<'_>>` rather than mandatory:
/// - CLI / Apple FFI / tests pass `Some(RawInput::Path(_))` — the natural
///   shape for code that already has a file path.
/// - `raw-wasm::render_bytes` passes `Some(RawInput::Bytes(_))` — the
///   browser only ever has the RAW in memory; PR-B (#555) wires this
///   through so Auto Profile lights up on the web.
/// - The legacy `maple_render_bytes` FFI entry still passes `None` (its
///   only consumer doesn't surface a profile selector yet). On that path
///   Auto Profile is unavailable and the view tail falls back to AgX —
///   the same byte-for-byte result as `Profile::Neutral`.
///
/// The full Auto Profile flow runs whenever the caller supplies a source
/// AND `model.profile == Profile::Auto` AND the JPEG extraction + curve
/// fit succeeds.
pub fn render_from_raw_with_quality_and_source(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
) -> Result<(u32, u32, Vec<u8>)> {
    // Section 0 (Auto Profile root-cause fix): when Profile=Auto and we
    // will actually fit a curve, force AutoExposureMode::Off so the fitted
    // curve owns the entire scene→JPEG brightness relationship. Otherwise
    // we double-normalize — Maple's mid-gray-anchor lift stacks on top of
    // the camera's already-baked AE, and the residual offset varies per
    // fixture (each scene has a different mid-gray geometric mean), so a
    // single fitted curve can't absorb it. RawTherapee's histmatching.cc
    // fits the same way: from a neutral render with no auto-exposure.
    //
    // Build the cache key first — a hit on the LRU implies the fit
    // already succeeded for this RAW, so we know `auto_will_fit = true`
    // without paying the JPEG extraction cost. Miss falls through to the
    // existing probe (`extract_preview` does a full JPEG decode; on a
    // cold path we still need it to gate `auto_will_fit`, otherwise the
    // fit-fail fallback runs AgX on un-AE-normalized scene-linear and
    // regressed test_0013 from 8.82 → 16.98 dE before the guard).
    let auto_cache_key = if model.profile == Profile::Auto {
        match &raw_source {
            Some(RawInput::Path(p)) => auto_profile::cache::CacheKey::from_path(p),
            Some(RawInput::Bytes { bytes, .. }) => {
                Some(auto_profile::cache::CacheKey::from_bytes(bytes))
            }
            None => None,
        }
    } else {
        None
    };
    let cached_lut = auto_cache_key
        .as_ref()
        .and_then(auto_profile::cache::get_lut);
    let auto_will_fit = cached_lut.is_some()
        || (model.profile == Profile::Auto
            && match &raw_source {
                Some(RawInput::Path(p)) => auto_profile::preview::extract_preview(p).is_some(),
                Some(RawInput::Bytes { bytes, ext }) => {
                    auto_profile::preview::extract_preview_from_bytes(bytes, ext).is_some()
                }
                None => false,
            });
    // POC gate (#913): Profile::Auto normally pins auto-exposure OFF because the
    // Auto Profile LUT owns the scene→JPEG brightness mapping (the LUT is fit
    // against the AE-Off buffer, see #871). When the LUT is disabled for the
    // POC, nothing remaps brightness, so AE MUST stay ON to anchor mid-gray to
    // 0.18 — otherwise the render enters AgX un-anchored and lands ~0.16 OKLab-L
    // too dark (the entire "chroma catastrophe" turned out to be this missing
    // anchor, not the chroma stage). Outside the POC, behaviour is unchanged.
    let poc_no_lut = std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_some();
    let auto_model;
    let active_model: &AdjustmentModel = if auto_will_fit && !poc_no_lut {
        auto_model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            ..model.clone()
        };
        &auto_model
    } else {
        model
    };
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, active_model, quality)?;

    // View transform (#550 post-fix): AgX + gamut compress + sRGB gamma
    // encode run UNCONDITIONALLY for both Auto and Neutral. Pre-#550 the
    // Auto branch REPLACED AgX with the scene-linear curve fit, throwing
    // away AgX's hue-restoring sigmoid + ratio-preserving compression and
    // measuring an S-curve mismatch vs the camera JPEG (T8 #548: shadows
    // biased +0.16, highlights −0.16 — the lone curve could not reproduce
    // AgX's sigmoid). The Auto Profile per-channel curve now layers ON TOP
    // of AgX in f32 sRGB-encoded display space (see below), a tone residual
    // toward the JPEG distribution rather than a wholesale replacement.
    stage("agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    // Buffer is in display-linear sRGB primaries here. Gamma encoding
    // happens later in `srgb_gamma_encode`. Name reflects that —
    // "srgb_linear", not "post_srgb_encode" which would have implied a
    // full sRGB encode (per PR #281 review feedback).
    dump_after("17_srgb_linear", &scene);
    stage("srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
    // Auto Profile (#537/#913) — per-image 3D color LUT fit from the
    // embedded JPEG and applied in f32 sRGB-encoded display space (same
    // domain the empirical Look LUT samples in, #519), layered on top of
    // AgX. The fit (`lut::fit_lut_*_display`) reads the JPEG via `/255`
    // directly — no inverse OETF, no Rec.2020 conversion — and Maple's
    // source buffer is in the same domain by construction. The LUT replaces
    // the retired #550 per-channel tone curve, carrying both the tone and
    // chroma residual toward the JPEG distribution. Identity (no-op =
    // AgX-Neutral output) when there's no RAW source (legacy
    // `maple_render_bytes` FFI) or the fit fails (no JPEG / too small /
    // too few surviving pairs).
    match (model.profile, &raw_source) {
        (Profile::Auto, Some(RawInput::Path(path))) => stage("auto_profile", || {
            scene.assert_space(ColorSpace::DisplayEncodedSrgb);
            let (w, h) = (scene.width as usize, scene.height as usize);
            let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
            let lut = match cached_lut.clone() {
                Some(l) => Some(l),
                None => {
                    let fitted = auto_profile::lut::fit_lut_from_raw_display(
                        path, pixels, w, h, raw.orientation,
                    );
                    if let (Some(key), Some(l)) = (auto_cache_key.clone(), fitted.as_ref()) {
                        auto_profile::cache::insert_lut(key, l.clone());
                    }
                    fitted
                }
            };
            if let Some(l) = lut {
                if std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_none() {
                    l.apply(pixels);
                }
            }
        }),
        (Profile::Auto, Some(RawInput::Bytes { bytes, ext })) => stage("auto_profile", || {
            scene.assert_space(ColorSpace::DisplayEncodedSrgb);
            let (w, h) = (scene.width as usize, scene.height as usize);
            let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
            let lut = match cached_lut.clone() {
                Some(l) => Some(l),
                None => {
                    let fitted = auto_profile::lut::fit_lut_from_bytes_display(
                        bytes, ext, pixels, w, h, raw.orientation,
                    );
                    if let (Some(key), Some(l)) = (auto_cache_key.clone(), fitted.as_ref()) {
                        auto_profile::cache::insert_lut(key, l.clone());
                    }
                    fitted
                }
            };
            if let Some(l) = lut {
                if std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_none() {
                    l.apply(pixels);
                }
            }
        }),
        _ => {}
    }
    // DisplayLookCurve (#371) — empirical per-channel LUT that closes
    // ~65% of the bias-to-ACR gap. Pre-#519 it ran as a `u8 → u8`
    // nearest lookup AFTER dither + quantize, which collapsed multiple
    // input codes onto one output code wherever LUT slope ≠ 1 and
    // reintroduced histogram gaps (visible banding). #519 moves the
    // sampling into f32 sRGB-encoded space with linear interpolation
    // between adjacent table entries — the dither below now controls
    // the only quantisation step in the chain.
    stage("look", || {
        let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
        look::apply(pixels, model.look);
    });
    let bytes = stage("dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
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

/// Fit the per-image Auto Profile [`auto_profile::curve::ProfileCurve`]
/// for a RAW + model WITHOUT rendering an output buffer (#812).
///
/// This reproduces EXACTLY the prefix of `render_from_raw_with_quality_and_source`
/// up to and including the `auto_profile` fit point — same `AutoExposureMode::Off`
/// guard, same develop chain, same `agx` → `rec2020_to_srgb` → `srgb_gamma_encode`
/// view-transform stages — then fits the curve from the resulting f32
/// sRGB-encoded display buffer against the embedded JPEG and returns it
/// instead of applying it and continuing to quantise.
///
/// It exists so a GPU host (Apple Metal #812, Web WebGL2 #394) can obtain
/// the fitted curve, bake it into a 3D LUT via [`auto_profile::bake_profile_lut`],
/// and apply it on the GPU in the SAME f32 sRGB-encoded display space the
/// CPU path fits in — keeping the GPU and CPU Auto Profile renders from
/// drifting. The host runs AgX + the rec2020→sRGB encode itself (on Apple
/// CoreImage's encode boundary); this entry's only job is the fit, which
/// requires the developed display buffer as the fit's source.
///
/// `quality` MUST match the quality the host's render uses, or the fitted
/// curve — and thus the per-band bias against the reference — will differ.
///
/// Returns `None` when `model.profile != Profile::Auto`, the embedded JPEG
/// can't be extracted, or the fit is degenerate (see
/// [`auto_profile::fit_curve_from_raw_display`]). The host falls back to
/// plain AgX (= `Profile::Neutral`) on `None`. The fit result is inserted
/// into the shared `auto_profile::cache` LRU so a subsequent CPU render of
/// the same RAW reuses it (and vice-versa).
pub fn fit_profile_curve_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
) -> Option<auto_profile::curve::ProfileCurve> {
    if model.profile != Profile::Auto {
        return None;
    }
    // Mirror the cache lookup in `render_from_raw_with_quality_and_source`
    // so a hit on either path serves the other without re-fitting.
    let auto_cache_key = match &raw_source {
        RawInput::Path(p) => auto_profile::cache::CacheKey::from_path(p),
        RawInput::Bytes { bytes, .. } => Some(auto_profile::cache::CacheKey::from_bytes(bytes)),
    };
    if let Some(c) = auto_cache_key.as_ref().and_then(auto_profile::cache::get) {
        return Some(c);
    }
    // Same `AutoExposureMode::Off` guard the render path applies before the
    // fit, so the fitted curve owns the whole scene→JPEG brightness mapping
    // (see the long comment at the top of the render entry).
    let auto_model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        ..model.clone()
    };
    let mut scene =
        develop_scene_linear_from_raw_with_quality(raw, &auto_model, quality).ok()?;
    // Reproduce the render path's view-transform prefix verbatim: AgX runs
    // unconditionally, then rec2020→sRGB primaries, then sRGB gamma encode.
    // The fit lives in `DisplayEncodedSrgb` — the buffer state right here.
    stage("agx", || agx::apply(&mut scene, model.contrast));
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    stage("srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
    scene.assert_space(ColorSpace::DisplayEncodedSrgb);
    let (w, h) = (scene.width as usize, scene.height as usize);
    let pixels: &[f32] = bytemuck::cast_slice(&scene.pixels);
    let fitted = match raw_source {
        RawInput::Path(path) => {
            auto_profile::fit_curve_from_raw_display(path, pixels, w, h, raw.orientation)
        }
        RawInput::Bytes { bytes, ext } => {
            auto_profile::fit_curve_from_bytes_display(bytes, ext, pixels, w, h, raw.orientation)
        }
    };
    if let (Some(key), Some(c)) = (auto_cache_key, fitted.as_ref()) {
        auto_profile::cache::insert(key, c.clone());
    }
    fitted
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
///
/// Synthetic inputs unconditionally run AgX — Auto Profile (#537) needs an
/// embedded JPEG to fit against, which only exists when a RAW file is the
/// source. `model.profile` is ignored on this path by design.
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
    stage("synth_srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
    // See `render_from_raw_with_quality` for the #519 ordering rationale.
    stage("synth_look", || {
        let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
        look::apply(pixels, model.look);
    });
    let bytes = stage("synth_dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
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
    stage("synth_srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
    // See `render_from_raw_with_quality` for the #519 ordering rationale.
    stage("synth_look", || {
        let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
        look::apply(pixels, model.look);
    });
    let bytes = stage("synth_dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
    Ok((w, h, bytes))
}

// Tests live in the sibling `tests.rs` file so this module stays under
// the 600-LOC budget (#482). Test contents were moved verbatim.
#[cfg(test)]
mod tests;

// Auto-Profile Path/Bytes render-parity test (#867) lives in its own sibling
// file so both it and `tests.rs` stay under the 600-LOC budget (#482).
#[cfg(test)]
mod auto_profile_parity_tests;
