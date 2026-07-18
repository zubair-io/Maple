//! Auto Profile fit entry points — develop a RAW through the PINNED fit
//! prefix, then fit the #550 curve (and, for #924, the per-image residual LUT)
//! for GPU hosts that bake them into a 3D LUT, plus the CPU render path's
//! Auto stage orchestration (#1085).
//!
//! ## The #1085 invariant — the fit develop is pinned to the default model
//!
//! Every fit (curve + residual, CPU render path + GPU host entries) samples a
//! buffer developed under [`fit_develop_model`] — `AdjustmentModel::default()`
//! with only `auto_exposure: Off` pinned (#550/#871) and the caller's
//! `profile` carried — NEVER the caller's live edit model. The fit is
//! therefore a pure function of the RAW (at a given develop quality/size):
//! the RAW-identity `auto_profile::cache` key is correct by construction,
//! renders can't depend on cache state or fit order, and a cold fit under an
//! edited model can no longer learn (and partially cancel) the user's edits.

use crate::error::Result;
use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::develop::develop_scene_linear_from_raw_with_quality;
use crate::pipeline::develop_sized::develop_scene_linear_sized_from_raw_with_quality;
use crate::pipeline::{stage, RenderQuality};
use crate::stages::{grain, split_tone};
use crate::types::adjustment::{AutoExposureMode, Profile};
use crate::view::auto_profile::cache::CacheKey;
use crate::view::auto_profile::curve::ProfileCurve;
use crate::view::auto_profile::lut::ColorLut;
use crate::view::auto_profile::preview::ExtractedPreview;
use crate::view::{agx, auto_profile, encode};
use crate::xmp::AdjustmentModel;

use super::RawInput;

/// Build the [`AdjustmentModel`] the fit develop runs with: the DEFAULT model
/// with `auto_exposure: Off` pinned and the caller's `profile` carried —
/// nothing else from the caller survives (#1085).
///
/// `auto_exposure: Off` is the existing #871/#550 split: the fitted tail owns
/// the whole scene→JPEG brightness mapping, so AE is disabled for the fit
/// develop. `profile` is the one field the fit genuinely needs from the
/// caller — it is what makes this a `Profile::Auto` fit at all (the entry
/// guards check it; the develop chain itself never reads it). Every other
/// field is pinned to [`AdjustmentModel::default()`] so the fit input — and
/// therefore the fitted curve/LUT under the RAW-identity cache key — cannot
/// depend on the caller's live edits.
///
/// This REPLACES the #972 variant, which cloned the caller's model and zeroed
/// the four high-frequency fields (`nr_color`, `nr_luminance`,
/// `sharpen_amount`, `capture_sharpening_amount`). Two reasons:
/// * Pinning to the default model is what makes the fit model-independent;
///   a caller clone (even a partially-zeroed one) keeps every other slider
///   leaking into the fit (#1085's bug).
/// * The CPU render path fits from a default-model develop — which runs the
///   DEFAULT `nr_color`@25 / `sharpen`@40 — and that path is what the
///   bit-exact color-pipeline harness gates. Keeping the GPU fit zeroed would
///   preserve #972's admitted (and harness-invisible) CPU↔GPU fit divergence;
///   pinning both to the same default model removes it. The cost is that the
///   GPU hosts' cold fit develop pays the default NR/sharpen again
///   (~9 s on the 100 MP reference frame — the #972 saving), traded for one
///   unified, deterministic fit definition across every path.
fn fit_develop_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: model.profile,
        ..AdjustmentModel::default()
    }
}

/// Develop a RAW through the EXACT (pinned) Auto Profile fit prefix and return
/// the `DisplayEncodedSrgb` buffer the curve / residual LUT fits sample
/// against:
///   * the pinned fit model from [`fit_develop_model`] — default model,
///     `auto_exposure: Off`, caller's `profile` carried (#1085; see that fn);
///   * the shared scene-linear develop chain (early-downsampled when
///     `max_long_edge` is `Some`, mirroring the sized render entry — the GPU
///     fit entries pass `None` for the full-size develop);
///   * the render's display tail up to the Auto Profile stage, every stage
///     fed the PINNED model's fields: `agx` with the pinned `contrast` (= the
///     default `0.0`, NOT the caller's — pre-#1085 the caller's contrast
///     leaked into the fit here), `split_tone` (#1111) and `grain` (#1110) at
///     their defaults (both identity short-circuits — present so the prefix
///     stays stage-for-stage the render chain even if defaults ever change),
///     then `rec2020→srgb` primaries, then `srgb` gamma encode. The fit lives
///     in `DisplayEncodedSrgb` — the buffer state on return.
///
/// Shared by every fit entry in this module so the fit inputs can never drift
/// from each other — one pinned prefix, CPU and GPU alike. It is the chain
/// `render_display_from_raw` runs for a default-model caller, stage for stage
/// — which is what lets `run_auto_profile_stage` treat that caller's render
/// buffer AS the fit buffer without a second develop.
fn develop_display_for_auto_fit(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: Option<u32>,
) -> Result<Image> {
    let auto_model = fit_develop_model(model);
    let mut scene = match max_long_edge {
        Some(mle) => {
            develop_scene_linear_sized_from_raw_with_quality(raw, &auto_model, quality, mle)?
        }
        None => develop_scene_linear_from_raw_with_quality(raw, &auto_model, quality)?,
    };
    stage("agx", || agx::apply(&mut scene, auto_model.contrast));
    stage("split_tone", || {
        split_tone::apply(
            &mut scene,
            auto_model.split_tone_shadow_hue,
            auto_model.split_tone_shadow_saturation,
            auto_model.split_tone_highlight_hue,
            auto_model.split_tone_highlight_saturation,
            auto_model.split_tone_balance,
        )
    });
    stage("grain", || {
        grain::apply(
            &mut scene,
            auto_model.grain_amount,
            auto_model.grain_size,
            auto_model.grain_roughness,
        )
    });
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    stage("srgb_gamma_encode", || {
        encode::srgb_gamma_encode(&mut scene)
    });
    scene.assert_space(ColorSpace::DisplayEncodedSrgb);
    Ok(scene)
}

/// Sensor long edge (px) above which the standalone Auto-Profile fit develops
/// only to the preview resolution instead of the full sensor (#1637). At and
/// below this the fit stays full-res so its fitted curve is byte-unchanged —
/// the memory win is only *needed*, and its small parity cost only *worth it*,
/// on the very large RAWs (~50 MP+) that jetsam-kill iOS by holding a ~1.4 GB
/// fit buffer concurrent with the render. ~8000 px ≈ 50 MP; it sits above every
/// color-pipeline fixture except the 100 MP `test_0000` (12288 px).
const AUTO_FIT_SIZED_SENSOR_LE: u32 = 8000;

/// `max_long_edge` for the standalone fit develop: the preview resolution on a
/// Proxy long edge the standalone fit develops at on a large sensor (#1647 M2).
/// The fit needs only the joint tone distribution of (developed RAW, embedded
/// JPEG) — a ~1.5 MP proxy is parity-equivalent (gated on `baseline_auto` ΔE)
/// and avoids holding a large developed buffer through the fit; the JPEG is
/// downsampled to match (`downsample_preview_for_fit`) so source bins ≥ target.
const AUTO_FIT_PROXY_LE: u32 = 1536;

fn auto_fit_max_long_edge(raw: &RawImage, preview: &ExtractedPreview) -> Option<u32> {
    if raw.width.max(raw.height) > AUTO_FIT_SIZED_SENSOR_LE {
        let preview_le = preview.image.width().max(preview.image.height());
        Some(preview_le.min(AUTO_FIT_PROXY_LE))
    } else {
        None
    }
}

/// Downsample the embedded JPEG to `max_long_edge` (the fit's develop target) so
/// the fit pairs a SMALL (developed-RAW, JPEG) couple. No-op for `None` (small
/// sensor) or already-small previews; parity-gated on `baseline_auto` ΔE (#1647).
fn downsample_preview_for_fit(
    mut preview: ExtractedPreview,
    max_long_edge: Option<u32>,
) -> ExtractedPreview {
    let Some(mle) = max_long_edge else {
        return preview;
    };
    let le = preview.image.width().max(preview.image.height());
    if le <= mle {
        return preview;
    }
    let scale = f64::from(mle) / f64::from(le);
    let nw = ((f64::from(preview.image.width()) * scale).round() as u32).max(1);
    let nh = ((f64::from(preview.image.height()) * scale).round() as u32).max(1);
    preview.image = preview
        .image
        .resize_exact(nw, nh, image::imageops::FilterType::Triangle);
    preview
}

/// Extract the embedded preview (+ color space) for `raw_source` — ONE
/// extraction shared by the curve fit, the residual fit, and the render
/// path's will-it-fit probe (#1085 perf companion: pre-fix the cold Auto
/// render extracted + JPEG-decoded the preview three times).
fn extract_preview_for_fit(raw_source: &RawInput<'_>) -> Option<ExtractedPreview> {
    match raw_source {
        RawInput::Path(p) => auto_profile::preview::extract_for_fit(p),
        RawInput::Bytes { bytes, ext } => {
            auto_profile::preview::extract_for_fit_from_bytes(bytes, ext)
        }
    }
}

/// Fit the per-image Auto Profile [`ProfileCurve`] for a RAW WITHOUT rendering
/// an output buffer (#812).
///
/// Develops the PINNED fit prefix ([`develop_display_for_auto_fit`] — the same
/// buffer the CPU render path fits from, #1085) and fits the curve from the
/// resulting f32 sRGB-encoded display buffer against the embedded JPEG.
///
/// It exists so a GPU host (Apple Metal #812, Web WebGL2 #394) can obtain
/// the fitted curve, bake it into a 3D LUT via [`auto_profile::bake_profile_lut`],
/// and apply it on the GPU in the SAME f32 sRGB-encoded display space the
/// CPU path fits in — keeping the GPU and CPU Auto Profile renders from
/// drifting. The host runs AgX + the rec2020→sRGB encode itself (on Apple
/// CoreImage's encode boundary); this entry's only job is the fit.
///
/// `quality` MUST match the quality the host's render uses, or the fitted
/// curve — and thus the per-band bias against the reference — will differ.
///
/// Returns `None` when `model.profile != Profile::Auto`, the embedded JPEG
/// can't be extracted, or the fit is degenerate (see
/// [`auto_profile::fit_curve_from_raw_display`]). The host falls back to
/// plain AgX (= `Profile::Neutral`) on `None`. The fit result is inserted
/// into the shared `auto_profile::cache` LRU so a subsequent CPU render of
/// the same RAW reuses it (and vice-versa) — sound since #1085 because every
/// path fits the same pinned develop.
pub fn fit_profile_curve_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
) -> Option<ProfileCurve> {
    if model.profile != Profile::Auto {
        return None;
    }
    // Mirror the cache lookup in the render path so a hit on either path
    // serves the other without re-fitting.
    let auto_cache_key = match &raw_source {
        RawInput::Path(p) => CacheKey::from_path(p, quality),
        RawInput::Bytes { bytes, .. } => Some(CacheKey::from_bytes(bytes, quality)),
    };
    if let Some(c) = auto_cache_key.as_ref().and_then(auto_profile::cache::get) {
        return Some(c);
    }
    // Extract BEFORE the multi-second develop — no preview ⇒ no fit possible.
    let preview = extract_preview_for_fit(&raw_source)?;
    // #1637: on a very large sensor, develop the fit only to the preview's
    // resolution (the JPEG it aligns against) — not the full sensor, a ~1.4 GB
    // buffer that, concurrent with the render, jetsam-killed iOS. Smaller
    // sensors keep the full-res fit (see `auto_fit_max_long_edge`).
    let mle = auto_fit_max_long_edge(raw, &preview);
    // #1647 M2: shrink the JPEG to the fit's proxy resolution so the pair the
    // curve fits over is ~1.5 MP, not the full embedded preview.
    let preview = downsample_preview_for_fit(preview, mle);
    let scene = develop_display_for_auto_fit(raw, model, quality, mle).ok()?;
    let (w, h) = (scene.width as usize, scene.height as usize);
    let pixels: &[f32] = bytemuck::cast_slice(&scene.pixels);
    let fitted = auto_profile::fit_display::fit_curve_from_preview_display(
        preview.image,
        preview.color_space,
        pixels,
        w,
        h,
        raw.orientation,
    );
    if let (Some(key), Some(c)) = (auto_cache_key, fitted.as_ref()) {
        auto_profile::cache::insert(key, c.clone());
    }
    fitted
}

/// Fit BOTH the #550 per-channel curve and the per-image residual 3D LUT for a
/// GPU host that bakes them into ONE composed CIColorCube / texture (#924), or
/// consumes them as two GPU passes (#925 P4b).
///
/// Develops the PINNED fit prefix ([`develop_display_for_auto_fit`], #1085),
/// then delegates to [`auto_profile::apply_pipeline::fit_auto_profile_artifacts`]
/// — fit curve, apply it to the fit buffer, fit the residual on the curved
/// buffer, so the residual's pairs are `(curve(maple), jpeg)` EXACTLY as the
/// CPU render path fits them. Both stages share the `auto_profile::cache` LRUs
/// with the CPU path (the fast path below skips the multi-second develop when
/// everything needed is already cached).
///
/// Env knobs (#1085 semantics): `MAPLE_DISABLE_AUTO_LUT` skips the residual
/// FIT (not just its use) — the host gets `(curve, None)` and bakes the curve
/// only. `MAPLE_AUTO_LUT_STRENGTH` scales the RETURNED residual toward
/// identity ([`ColorLut::with_strength`]); the cache always holds the
/// full-strength fit, so the env value can never be baked into a cached LUT.
///
/// Returns:
/// - `None` when NEITHER stage applies — not `Profile::Auto`, or no embedded
///   JPEG so both fits fail. The host renders plain AgX (= `Profile::Neutral`).
/// - `Some((curve, residual))` otherwise, where EITHER element may be `None`:
///   * `(Some, Some)` — the full tail; the host bakes `curve ∘ residual`.
///   * `(Some, None)` — curve only (too few residual pairs, or the residual
///     disabled); curve-only bake, byte-identical to the #812 cube.
///   * `(None, Some)` — residual only (degenerate curve but a usable JPEG). The
///     residual was fit on the UN-curved AE-off buffer, so it still
///     brightness-anchors maple→jpeg. This case MUST NOT collapse to plain AgX:
///     an AE-off buffer with no tail renders DARKER than Neutral (#871), so
///     dropping the residual here would make selecting "Auto" *darken* the
///     image.
pub fn fit_auto_profile_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: RawInput<'_>,
) -> Option<(Option<ProfileCurve>, Option<ColorLut>)> {
    if model.profile != Profile::Auto {
        return None;
    }
    let auto_cache_key = match &raw_source {
        RawInput::Path(p) => CacheKey::from_path(p, quality),
        RawInput::Bytes { bytes, .. } => Some(CacheKey::from_bytes(bytes, quality)),
    };

    // Fast path: everything obtainable is already cached (e.g. a CPU render of
    // the same RAW ran first) — return without the multi-second develop. The
    // hit condition lives in [`cached_auto_profile_fit`] so the FFI entries
    // can probe it BEFORE reading/decoding the RAW (#2035) without a second
    // copy of the semantics.
    if let Some(pair) = cached_auto_profile_fit(model, auto_cache_key.as_ref()) {
        return Some(pair);
    }

    let lut_disabled = auto_profile::lut::lut_disabled_by_env();
    let cached_curve = auto_cache_key.as_ref().and_then(auto_profile::cache::get);
    let cached_lut = if lut_disabled {
        None
    } else {
        auto_cache_key
            .as_ref()
            .and_then(auto_profile::cache::get_lut)
    };

    // A cached curve with no cached LUT still needs the develop to fit the
    // residual (a legitimately-`None` residual can't be distinguished from
    // "never fit" via the cache, but the host caches the baked artifacts, so
    // this re-fits at most once per image).
    let (curve, residual) = match extract_preview_for_fit(&raw_source) {
        // No embedded preview: nothing beyond the cache can be fit.
        None => (cached_curve, cached_lut),
        Some(preview) => {
            // #1637: size the fit develop to the preview on large sensors
            // only (see the curve-only fit above + `auto_fit_max_long_edge`).
            let mle = auto_fit_max_long_edge(raw, &preview);
            // #1647 M2: shrink the JPEG to the proxy so the curve+residual
            // fit over a ~1.5 MP pair, not the full embedded preview.
            let preview = downsample_preview_for_fit(preview, mle);
            let mut scene = develop_display_for_auto_fit(raw, model, quality, mle).ok()?;
            let (w, h) = (scene.width as usize, scene.height as usize);
            let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
            auto_profile::apply_pipeline::fit_auto_profile_artifacts(
                pixels,
                w,
                h,
                raw.orientation,
                Some(&preview),
                auto_cache_key.as_ref(),
                cached_curve,
                cached_lut,
            )
        }
    };

    if curve.is_none() && residual.is_none() {
        return None;
    }
    let k = auto_profile::lut::lut_strength_from_env();
    let residual = if k == 1.0 {
        residual
    } else {
        residual.map(|l| l.with_strength(k))
    };
    Some((curve, residual))
}

/// Cache-only probe (#2035): the fully-resolved Auto Profile fit result for
/// `key`, **iff** a call to [`fit_auto_profile_from_raw`] with the same
/// `model` + key would take its fast path — i.e. both artifacts are already
/// resolvable from the shared LRUs without the multi-second develop. `None`
/// means a fresh fit would still need the RAW (or `model` isn't
/// `Profile::Auto`, where the fit returns no tail anyway).
///
/// This is THE fast-path condition of `fit_auto_profile_from_raw`, extracted
/// so the FFI fit entries (`maple_gpu_fit_auto_profile`,
/// `maple_compute_auto_profile_lut`) can probe it BEFORE paying the
/// full-file `fs::read` + decode their miss path needs — on a session
/// re-open of an already-fit image the probe hit makes the whole FFI call
/// artifact-copy cheap. On a hit the returned pair is byte-identical to what
/// the fit itself would return: same LRU entries, same
/// `MAPLE_DISABLE_AUTO_LUT` / `MAPLE_AUTO_LUT_STRENGTH` env semantics
/// (the cache always holds the full-strength residual; the strength scale is
/// applied on the way out, exactly like the fit's own return).
///
/// A hit requires a cached CURVE (plus a cached LUT unless the residual is
/// env-disabled) — a cached LUT alone is NOT a hit, mirroring the fit: a
/// legitimately-`None` residual can't be distinguished from "never fit" via
/// the cache, so a curve-less state always re-develops.
pub fn cached_auto_profile_fit(
    model: &AdjustmentModel,
    key: Option<&CacheKey>,
) -> Option<(Option<ProfileCurve>, Option<ColorLut>)> {
    if model.profile != Profile::Auto {
        return None;
    }
    let key = key?;
    let cached_curve = auto_profile::cache::get(key)?;
    let lut_disabled = auto_profile::lut::lut_disabled_by_env();
    let cached_lut = if lut_disabled {
        None
    } else {
        // A curve without its paired LUT is a MISS — the develop must run to
        // fit the residual (see the doc above).
        Some(auto_profile::cache::get_lut(key)?)
    };
    let k = auto_profile::lut::lut_strength_from_env();
    let residual = if k == 1.0 {
        cached_lut
    } else {
        cached_lut.map(|l| l.with_strength(k))
    };
    Some((Some(cached_curve), residual))
}

/// The CPU render path's Auto Profile stage (#1085): obtain the (pinned-fit)
/// artifacts and apply them to the render buffer `scene`.
///
/// Two routes to the artifacts:
/// * **Render buffer IS the pinned fit buffer** — when the AE-pinned render
///   model equals [`fit_develop_model`] (i.e. the caller's model differs from
///   the default in nothing but possibly `auto_exposure`), the buffer this
///   render just developed is bit-identical to the pinned fit develop, so the
///   fit samples it directly — no second develop. This is the cold-open
///   default-model case, and byte-for-byte the pre-#1085 behaviour for it.
/// * **Caller's model is edited** — fit from a SEPARATE pinned develop
///   ([`fit_artifacts_from_pinned_develop`]); only the APPLY touches the
///   caller's render. Pre-#1085 this case fit from the edited buffer,
///   mapping the user's edits back onto the unchanged JPEG targets —
///   partially cancelling them and poisoning the RAW-keyed cache.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_auto_profile_stage(
    scene: &mut Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    active_model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: Option<u32>,
    preview: Option<ExtractedPreview>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) {
    scene.assert_space(ColorSpace::DisplayEncodedSrgb);
    let (w, h) = (scene.width as usize, scene.height as usize);
    if *active_model == fit_develop_model(model) {
        let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
        auto_profile::apply_auto_profile(
            pixels,
            w,
            h,
            raw.orientation,
            preview.as_ref(),
            cache_key,
            cached_curve,
            cached_lut,
        );
        return;
    }
    let (curve, residual) = fit_artifacts_from_pinned_develop(
        raw,
        model,
        quality,
        max_long_edge,
        preview,
        cache_key,
        cached_curve,
        cached_lut,
    );
    let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
    if let Some(c) = &curve {
        auto_profile::apply_curve(pixels, c);
    }
    if let Some(l) = &residual {
        l.apply_with_strength(pixels, auto_profile::lut::lut_strength_from_env());
    }
}

/// Obtain the Auto Profile artifacts for an EDITED caller model: reuse the
/// cache where possible, otherwise develop the pinned fit buffer (sized like
/// the render that asked, so the fit cost tracks the render cost) and fit
/// there. Returns `(curve, residual)` with the residual already honouring
/// `MAPLE_DISABLE_AUTO_LUT` (strength stays with the caller's apply).
#[allow(clippy::too_many_arguments)]
fn fit_artifacts_from_pinned_develop(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: Option<u32>,
    preview: Option<ExtractedPreview>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) -> (Option<ProfileCurve>, Option<ColorLut>) {
    let lut_disabled = auto_profile::lut::lut_disabled_by_env();
    let cached_lut = if lut_disabled { None } else { cached_lut };
    // Everything needed is cached → no develop.
    if cached_curve.is_some() && (lut_disabled || cached_lut.is_some()) {
        return (cached_curve, cached_lut);
    }
    // No embedded preview → nothing beyond the cache can be fit.
    let Some(preview) = preview else {
        return (cached_curve, cached_lut);
    };
    let Ok(mut side) = develop_display_for_auto_fit(raw, model, quality, max_long_edge) else {
        return (cached_curve, cached_lut);
    };
    let (w, h) = (side.width as usize, side.height as usize);
    let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut side.pixels);
    auto_profile::apply_pipeline::fit_auto_profile_artifacts(
        pixels,
        w,
        h,
        raw.orientation,
        Some(&preview),
        cache_key,
        cached_curve,
        cached_lut,
    )
}

// Tests live in the sibling `auto_fit_tests.rs` file so this module stays
// under the 600-LOC hard budget. Test contents were moved verbatim.
#[cfg(test)]
#[path = "auto_fit_tests.rs"]
mod tests;
