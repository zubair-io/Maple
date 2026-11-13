// develop/entries.rs — the three thin public entries into the develop
// chain, split out of `mod.rs` (#3409) so both stay under the file-size
// budget with real margin (#2311). Pure code move: every one of these is a
// forwarding wrapper over
// `develop_scene_linear_from_raw_with_quality_cancellable_with_gain`, which
// stays in `mod.rs` alongside the chain it runs.
//
// They exist as separate entries rather than one function with flags
// because each is called from a different place with a different appetite:
// most callers want the `Image` and nothing else, the cancellable pair is
// what a cold open needs to unwind mid-stage (#951), and the `_with_gain`
// variants are what the tile path threads its AE anchor back through
// (#1167).

use super::develop_scene_linear_from_raw_with_quality_cancellable_with_gain;
use super::RenderQuality;
use crate::cancel::CancelToken;
use crate::error::Result;
use crate::image::RawImage;
use crate::xmp::AdjustmentModel;

/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, tone_curves, vibrance, saturation,
/// hsl, clarity, texture, dehaze, sharpen, nr_luminance, nr_color.
/// Non-cancellable wrapper — forwards to
/// [`develop_scene_linear_from_raw_with_quality_cancellable`] with a
/// never-cancel token. Every existing caller (CLI, WASM, the legacy FFI
/// entries, tests, `auto_fit`) routes through here, so a completed develop is
/// byte-for-byte identical to before #951.
#[inline]
pub fn develop_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    develop_scene_linear_from_raw_with_quality_cancellable(
        raw,
        model,
        quality,
        CancelToken::never(),
    )
}

/// Cancellable variant of [`develop_scene_linear_from_raw_with_quality`].
///
/// Threads `cancel` into the expensive stage kernels (`demosaic`, `sharpen`,
/// `nr_luminance`, `nr_color`) so a long cold-open develop can unwind mid-
/// stage (#951 — the ~8.5 s `nr_color` is the freeze a between-stages-only
/// check could not interrupt). Also checks the token at the top (a pre-set
/// flag bails before demosaic) and after each heavy stage, returning
/// `Err(Error::Cancelled)` the moment the host requests cancellation.
///
/// With a never-cancel token every check is a no-op branch and the cancellable
/// stage variants run identical math, so the output is bit-identical to the
/// wrapper above.
pub fn develop_scene_linear_from_raw_with_quality_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<crate::image::Image> {
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain(raw, model, quality, cancel)
        .map(|(scene, _ae_gain)| scene)
}

/// Non-cancellable variant of
/// [`develop_scene_linear_from_raw_with_quality_cancellable_with_gain`].
pub fn develop_scene_linear_from_raw_with_quality_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(crate::image::Image, f32)> {
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain(
        raw,
        model,
        quality,
        CancelToken::never(),
    )
}
