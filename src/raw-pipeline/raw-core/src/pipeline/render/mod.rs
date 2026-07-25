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
    develop_sized::develop_scene_linear_sized_from_raw_with_quality, dump_after, stage,
    RenderQuality,
};
use crate::{
    error::Result,
    image::{Image, RawImage},
    stages::{color_grade, grain},
    types::adjustment::{AutoExposureMode, Profile},
    view::{acr_match, agx, auto_profile, encode},
    xmp::AdjustmentModel,
};

/// Auto Profile fit entry points (curve + residual LUT) live in a submodule to
/// keep this file under the size budget; re-exported so `pipeline::{…}` and the
/// FFI keep resolving `fit_profile_curve_from_raw` / `fit_auto_profile_from_raw`.
mod auto_fit;
pub use auto_fit::{
    cached_auto_profile_fit, fit_auto_profile_from_raw, fit_profile_curve_from_raw,
};

// Sized display render + `native_render_dims` (#1101) — size-budget split.
mod sized;
pub use sized::{native_render_dims, render_sized_from_raw_with_quality_and_source};

// The orientation + crop tail, shared by the display and export depths (#943).
mod finish;

// Export render — the display chain at a caller-chosen depth / primaries (#943).
mod export;
pub use export::{render_export_from_raw, ExportDepth, ExportPixels};

// Synthetic-input render entries — the view transform applied to an already
// scene-linear buffer (#943 size-budget split); re-exported so `pipeline::{…}`
// and `maple-cli synthetic` keep resolving them.
mod synthetic;
pub use synthetic::{render_from_scene_linear, render_from_scene_linear_with_chain};

// Scene-linear (no-view-tail) render entries — fp16/f32 RGBA pack + orient
// (#1170 size-budget split); re-exported so `pipeline::{…}` keeps resolving them.
mod scene_linear;
pub use scene_linear::{
    render_scene_linear_from_raw_with_quality, render_scene_linear_from_raw_with_quality_f32,
    render_scene_linear_from_raw_with_quality_f32_cancellable,
    render_scene_linear_from_raw_with_quality_f32_cancellable_with_gain,
    render_scene_linear_sized_from_raw_with_quality,
    render_scene_linear_sized_from_raw_with_quality_f32,
    render_scene_linear_sized_from_raw_with_quality_f32_cancellable,
    render_scene_linear_sized_from_raw_with_quality_f32_cancellable_with_gain,
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
    render_display_from_raw(raw, model, quality, raw_source, None)
}

/// Display-encoded entry: [`render_display_scene`] into sRGB primaries, then
/// the 8-bit terminal quantize and the geometry tail. Private to this module
/// tree — the unsized wrapper above and the sized wrapper (`render/sized.rs`)
/// pin the two supported shapes.
fn render_display_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: Option<u32>,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = render_display_scene(
        raw,
        model,
        quality,
        raw_source,
        max_long_edge,
        encode::TargetPrimaries::Srgb,
    )?;
    let (w, h) = (scene.width, scene.height);
    let bytes = stage("dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
    Ok(finish::apply_geometry(
        &bytes,
        w,
        h,
        raw.orientation,
        &model.crop,
    ))
}

/// Shared body of every display-referred render: develop (full-res or
/// early-downsample sized, per `max_long_edge`), then the view tail up to and
/// including the display encode. Returns the f32 display-ENCODED buffer, one
/// step short of quantizing — the terminal depth is the caller's choice
/// (8-bit for the canvas, 16-bit for a TIFF master, #943), and everything
/// that determines colour has already happened by the time it returns. That
/// is what makes export and canvas the same pixels rather than two pipelines
/// that agree by inspection.
///
/// `target` selects the output primaries. Every pre-existing caller passes
/// [`encode::TargetPrimaries::Srgb`], which is byte-for-byte the previous
/// hard-coded `rec2020_to_srgb` behaviour.
fn render_display_scene(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: Option<u32>,
    target: encode::TargetPrimaries,
) -> Result<Image> {
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
    // extraction probe — whose decoded preview is now RETAINED and threaded
    // through both fits (#1085 perf companion: pre-fix the probe's full JPEG
    // decode was discarded and each fit re-extracted, 3× total).
    // `MAPLE_DISABLE_AUTO_PROFILE` — when set, the entire Auto Profile system
    // (cache lookup, preview extraction, will-fit probe) is bypassed. Any stale
    // cached value is intentionally ignored so disabled mode cannot leak through.
    let auto_profile_disabled = std::env::var_os("MAPLE_DISABLE_AUTO_PROFILE").is_some();
    let auto_cache_key = if !auto_profile_disabled && model.profile == Profile::Auto {
        match &raw_source {
            Some(RawInput::Path(p)) => auto_profile::cache::CacheKey::from_path(p, quality),
            Some(RawInput::Bytes { bytes, .. }) => {
                Some(auto_profile::cache::CacheKey::from_bytes(bytes, quality))
            }
            None => None,
        }
    } else {
        None
    };
    let cached_lut = auto_cache_key
        .as_ref()
        .and_then(auto_profile::cache::get_lut);
    let cached_curve = auto_cache_key.as_ref().and_then(auto_profile::cache::get);
    let preview = if !auto_profile_disabled
        && model.profile == Profile::Auto
        && (cached_curve.is_none() || cached_lut.is_none())
    {
        match &raw_source {
            Some(RawInput::Path(p)) => auto_profile::preview::extract_for_fit(p),
            Some(RawInput::Bytes { bytes, ext }) => {
                auto_profile::preview::extract_for_fit_from_bytes(bytes, ext)
            }
            None => None,
        }
    } else {
        None
    };
    let auto_will_fit = cached_curve.is_some() || cached_lut.is_some() || preview.is_some();
    // Profile::Auto pins auto-exposure OFF because the Auto Profile tail owns the
    // scene→JPEG brightness mapping: the #550 curve is fit against the AE-Off
    // display buffer (#871) and the residual LUT layers on it. `auto_will_fit` is a
    // cheap PROBE — a cache hit, or an extractable embedded preview — that predicts
    // the fit will succeed, so AE can be pinned BEFORE develop (the fit itself needs
    // the developed buffer, so the real fit result isn't known yet). When the probe
    // is false (no preview) AE stays ON to anchor mid-gray to 0.18 — otherwise AgX
    // runs un-anchored ~0.16 OKLab-L too dark (#913; regressed test_0013 8.82 →
    // 16.98 dE before this guard). The probe can over-predict on a degenerate-but-
    // extractable preview (the actual fit still returns None); in that case the LUT's
    // full-map fallback (see `apply_auto_profile`) anchors brightness, and only a
    // BOTH-fits-fail preview leaves an AE-off frame. The residual LUT never owns
    // brightness, so disabling it (`MAPLE_DISABLE_AUTO_LUT` / `…_STRENGTH=0`) does
    // NOT flip AE back on — that path renders the pure #550 curve, which still does.
    let auto_model;
    let active_model: &AdjustmentModel = if auto_will_fit {
        auto_model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            ..model.clone()
        };
        &auto_model
    } else {
        model
    };
    let mut scene = match max_long_edge {
        // Sized: early-downsample develop — post-demosaic stages run on the
        // viewport-sized buffer. `None` keeps the unsized entry byte-for-byte.
        Some(mle) => {
            develop_scene_linear_sized_from_raw_with_quality(raw, active_model, quality, mle)?
        }
        None => develop_scene_linear_from_raw_with_quality(raw, active_model, quality)?,
    };

    // View transform (#550 post-fix): AgX + gamut compress + sRGB gamma
    // encode run UNCONDITIONALLY for both Auto and Neutral. Pre-#550 the
    // Auto branch REPLACED AgX with the scene-linear curve fit, throwing
    // away AgX's hue-restoring sigmoid + ratio-preserving compression and
    // measuring an S-curve mismatch vs the camera JPEG (T8 #548: shadows
    // biased +0.16, highlights −0.16 — the lone curve could not reproduce
    // AgX's sigmoid). The Auto Profile per-channel curve now layers ON TOP
    // of AgX in f32 sRGB-encoded display space (see below), a tone residual
    // toward the JPEG distribution rather than a wholesale replacement.
    // View transform dispatch — Profile selects between:
    //   Neutral/Auto (fallback): AgX scene-referred sigmoid
    //   AcrMatch (#1722): fitted ACR-match model (selectable, not yet default)
    match model.profile {
        Profile::AcrMatch => {
            stage("acr_match", || acr_match::apply(&mut scene));
        }
        _ => {
            stage("agx", || agx::apply(&mut scene, model.contrast));
        }
    }
    dump_after("16_agx", &scene);
    // Split toning (#1111, tone/zoom design § 10.3) — display-linear Oklab
    // a/b tint with a balance-shifted crossover; L untouched. Runs before
    // grain so the monochromatic noise lands on the graded image untinted.
    // Any out-of-gamut push from split-tone / grain is caught by the
    // hue-preserving Oklab compression in `rec2020_to_srgb` below (the sRGB
    // hull ⊂ the Rec.2020 working hull), so they need no separate compress
    // pass here (#1942).
    stage("color_grade", || color_grade::apply_model(&mut scene, model));
    dump_after("16a_color_grade", &scene);
    // Film grain (#1110, tone/zoom design § 10.2) — display-linear
    // (post-AgX, before the target gamut): grain is a display-domain
    // aesthetic; injected scene-linear its amplitude would swing with
    // exposure. Identity short-circuit at amount 0 keeps the baseline
    // bit-identical.
    stage("grain", || {
        grain::apply(
            &mut scene,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
        )
    });
    dump_after("16b_grain", &scene);
    stage("rec2020_to_srgb", || {
        encode::rec2020_to_display(&mut scene, target)
    });
    // Buffer is in display-linear sRGB primaries here. Gamma encoding
    // happens later in `srgb_gamma_encode`. Name reflects that —
    // "srgb_linear", not "post_srgb_encode" which would have implied a
    // full sRGB encode (per PR #281 review feedback).
    dump_after("17_srgb_linear", &scene);
    stage("srgb_gamma_encode", || {
        encode::srgb_gamma_encode(&mut scene)
    });
    // Auto Profile (#537/#913) — the per-image color tail toward the embedded
    // JPEG, in f32 sRGB-encoded display space: the #550 per-channel curve, then a
    // residual 3D LUT fit on the curved buffer. The fit samples the PINNED
    // default-model develop (#1085) — when the caller's model IS effectively
    // default that's this very buffer; otherwise a separate pinned develop —
    // see `auto_fit::run_auto_profile_stage` for the routing and
    // `apply_pipeline::fit_auto_profile_artifacts` for the ordering/cache
    // contract. No-op for Neutral, no RAW source (legacy `maple_render_bytes`
    // FFI), or a failed fit.
    if model.profile == Profile::Auto && raw_source.is_some() {
        stage("auto_profile", || {
            auto_fit::run_auto_profile_stage(
                &mut scene,
                raw,
                model,
                active_model,
                quality,
                max_long_edge,
                preview,
                auto_cache_key.as_ref(),
                cached_curve,
                cached_lut,
            );
        });
        // Hue-preserving gamut guard AFTER the Auto Profile curve+LUT (#1942):
        // that stack runs in display-encoded space and can push a channel back
        // out of [0, 1] or rotate a saturated color out of gamut, which the
        // final `dither_and_quantize` would otherwise hard-clip per-channel
        // (posterising pushed color — the #438/#1621 defect class). Inert on
        // in-gamut pixels; only reshapes genuinely out-of-gamut post-LUT ones.
        stage("auto_profile_gamut_guard", || {
            encode::gamut_guard_display_encoded_srgb(&mut scene)
        });
    }
    // The DisplayLookCurve (#371) used to shape pixels here; #443 retired
    // the static Look LUT and the Auto Profile stage (`view::auto_profile`,
    // applied above) now owns per-image view-shaping. The `Look` enum
    // survives only for XMP back-compat (legacy `papp:Look` migrates to
    // `papp:Profile`), so there is no per-pixel Look pass — quantize (the
    // caller's, at the caller's depth) plus the geometry tail in
    // `render::finish` are all that remain.
    //
    // The buffer is returned at its actual rendered dimensions — `Full`
    // matches the sensor, `Preview` is half-res in both axes (because of
    // `demosaic::half_res`), and Apple/Web consumers handle the resolution
    // gap via their lazy display transform (CIImage scale on Apple; texture
    // upload on Web). Pixel-doubling here added ~300 MB of FFI traffic and
    // 4× the allocator pressure on a 100 MP RAW for no extra information.
    Ok(scene)
}

// Tests live in the sibling `tests.rs` file so this module stays under
// the 600-LOC budget (#482). Test contents were moved verbatim.
#[cfg(test)]
mod tests;

// T6 Auto Profile dispatch tests live in their own sibling file so both
// `tests.rs` and this file stay under the 600-LOC hard budget.
#[cfg(test)]
mod tests_dispatch;

// Auto-Profile Path/Bytes render-parity test (#867) lives in its own sibling
// file so both it and `tests.rs` stay under the 600-LOC budget (#482).
#[cfg(test)]
mod auto_profile_parity_tests;

// Sized display render + native_render_dims tests (#1101) — own sibling file
// for the same size-budget reason.
#[cfg(test)]
mod sized_display_tests;

// Crop / straighten integration tests (#277) — own sibling file so tests.rs
// stays under the 600-LOC hard budget (#772).
#[cfg(test)]
mod crop_tests;

// Dither-terminal static source gate (#1627 scope addition, ticket #441) —
// own sibling file per the same size-budget convention.
#[cfg(test)]
mod dither_terminal_tests;
