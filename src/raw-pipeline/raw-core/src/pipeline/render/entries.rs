//! Public 8-bit display render entries; thin wrappers over the shared terminal.
use super::{render_display_from_raw, RawInput, RenderQuality};
use crate::{error::Result, film, image::RawImage, xmp::AdjustmentModel};

/// Per spec § 02 filter chain, slice-1 through slice-5 subset:
/// * Highlight reconstruction (§ 3.3a), SceneToneControls (§ 3.6 steps 1-5),
///   Vibrance + Saturation (§ 3.7, Oklab), Clarity + Texture (§ 3.8),
///   Dehaze (§ 3.9), Richardson-Lucy sharpen (§ 3.10, 3-iter, Gaussian PSF),
///   simplified NR (§ 3.11, L-blur + chroma-blur in Oklab).
/// * Crop (§ 3.12) skipped — no slice-5 fixture exercises it; lands with
///   canonical XMP in slice 7.
/// * Tone curves (§ 3.6 steps 6-7) deferred to slice 7; § 3.6b's
///   DisplayReferredCurve landed later as `stages::display_tone_curve` (#2232).
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
    render_display_from_raw(raw, model, quality, raw_source, None, None)
}

/// Sibling of [`render_from_raw_with_quality_and_source`] that also threads
/// a baked film-look LUT (Task 1 [`film::FilmLut`]) through to the
/// `film_look` stage (Task 3) between `color_grade` and `grain`. This is
/// the single entry every host (CLI, Apple FFI, WASM) calls when a look is
/// active (epic #2683).
///
/// `film_lut: None` renders byte-identical to
/// [`render_from_raw_with_quality_and_source`] regardless of
/// `model.film_look` / `model.film_strength` — a host that can't resolve
/// the `.mlut` asset (missing file, disabled catalog) passes `None` and
/// gets the exact no-look render rather than a render with dangling
/// look-selection state.
pub fn render_from_raw_with_quality_source_and_film(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    film_lut: Option<&film::FilmLut>,
) -> Result<(u32, u32, Vec<u8>)> {
    render_display_from_raw(raw, model, quality, raw_source, None, film_lut)
}
