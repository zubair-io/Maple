//! Synthetic-input render entries — the view transform applied to an
//! already-scene-linear `Image` rather than to a decoded RAW.
//!
//! Split out of `render/mod.rs` (#943) so that file stays inside the 600-LOC
//! hard budget, per the #482 / #772 convention already used for `sized.rs`,
//! `scene_linear.rs` and `auto_fit.rs`. Moved verbatim — no behaviour change.
//! `super` is `pipeline::render`.

use super::{dump_after, stage};
use crate::{
    error::Result,
    image::{ColorSpace, Image},
    stages::{
        clarity, dehaze, grain, hsl, noise_reduction, saturation, scene_tone_controls, sharpen,
        split_tone, texture, vibrance, vignette,
    },
    view::{agx, encode},
    xmp::AdjustmentModel,
};

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
    // Split toning (#1111) — same display-linear position as the RAW path.
    stage("synth_split_tone", || {
        split_tone::apply(
            &mut scene,
            model.split_tone_shadow_hue,
            model.split_tone_shadow_saturation,
            model.split_tone_highlight_hue,
            model.split_tone_highlight_saturation,
            model.split_tone_balance,
        )
    });
    dump_after("16a_split_tone", &scene);
    // Film grain (#1110) — same display-linear position as the RAW path.
    stage("synth_grain", || {
        grain::apply(
            &mut scene,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
        )
    });
    dump_after("16b_grain", &scene);
    stage("synth_rec2020_to_srgb", || {
        encode::rec2020_to_srgb(&mut scene)
    });
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    stage("synth_srgb_gamma_encode", || {
        encode::srgb_gamma_encode(&mut scene)
    });
    // No per-pixel Look pass — #443 retired the static Look LUT (see
    // `render_from_raw_with_quality`); Auto Profile owns view-shaping.
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
/// White-balance is skipped — the synthetic input is generated directly in
/// the Rec.2020 working space at a known brightness, so running a WB delta
/// over it would only muddy the artefact under test. Scene-tone-controls
/// (exposure/brightness/highlights/shadows/whites/blacks) IS run (#1627
/// banding-gate machinery needs exposure/shadows/blacks slider-extreme
/// sweeps on gradient fixtures); it identity-short-circuits at the default
/// model so every existing clarity/dehaze/sharpen/halo detector that calls
/// this with a default-tone-controls model sees a byte-identical trace.
/// Vibrance and saturation are kept (they scale around the achromatic axis,
/// so they're no-ops on neutrals but DO affect saturated primaries the way
/// a real pixel would see). Stage numbering matches the real RAW develop
/// chain in `develop.rs`, with no dump for the skipped stage (so
/// `06_white_balance` is absent from this trace by design).
pub fn render_from_scene_linear_with_chain(
    image: Image,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = image;
    scene.assert_space(ColorSpace::SceneLinearRec2020);
    dump_after("00_synthetic_input", &scene);
    // White-balance deliberately skipped — see doc-comment. Scene-tone-controls
    // runs (identity no-op at the default model) so exposure/shadows/blacks
    // slider-extreme sweeps (#1627) see their real pipeline effect.
    stage("synth_scene_tone_controls", || {
        scene_tone_controls::apply(&mut scene, model)
    });
    dump_after("07_scene_tone_controls", &scene);
    stage("synth_vibrance", || {
        vibrance::apply(&mut scene, model.vibrance)
    });
    dump_after("08_vibrance", &scene);
    stage("synth_saturation", || {
        saturation::apply(&mut scene, model.saturation)
    });
    dump_after("09_saturation", &scene);
    // HSL 8-band (#1112) — same chain position as the real develop path
    // (after saturation, before clarity). Identity short-circuit on
    // all-default model. Added for the #1733 clamp audit: HSL's per-band
    // SAT slider is a chroma-scaling stage like vibrance/saturation and
    // needs the same banding-gate coverage (see `stages::hsl`'s
    // `hsl_soft_compress` fix).
    stage("synth_hsl", || {
        hsl::apply(
            &mut scene,
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
    dump_after("09b_hsl", &scene);
    stage("synth_clarity", || {
        clarity::apply(&mut scene, model.clarity)
    });
    dump_after("10_clarity", &scene);
    stage("synth_texture", || {
        texture::apply(&mut scene, model.texture)
    });
    dump_after("11_texture", &scene);
    stage("synth_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    // Vignette (#1109) — same chain position as develop (local_adjustments
    // is absent on this synthetic path; vignette still precedes sharpen).
    stage("synth_vignette", || {
        vignette::apply(&mut scene, model.vignette_amount, model.vignette_feather)
    });
    dump_after("12c_vignette", &scene);
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
    stage("synth_nr_luminance", || {
        noise_reduction::apply_luminance(&mut scene, model.nr_luminance, None, 100)
    });
    dump_after("14_nr_luminance", &scene);
    stage("synth_nr_color", || {
        noise_reduction::apply_color(&mut scene, model.nr_color, None, 100)
    });
    dump_after("15_nr_color", &scene);
    stage("synth_agx", || agx::apply(&mut scene, model.contrast));
    dump_after("16_agx", &scene);
    // Split toning (#1111) — same display-linear position as the RAW path.
    stage("synth_split_tone", || {
        split_tone::apply(
            &mut scene,
            model.split_tone_shadow_hue,
            model.split_tone_shadow_saturation,
            model.split_tone_highlight_hue,
            model.split_tone_highlight_saturation,
            model.split_tone_balance,
        )
    });
    dump_after("16a_split_tone", &scene);
    // Film grain (#1110) — same display-linear position as the RAW path.
    stage("synth_grain", || {
        grain::apply(
            &mut scene,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
        )
    });
    dump_after("16b_grain", &scene);
    stage("synth_rec2020_to_srgb", || {
        encode::rec2020_to_srgb(&mut scene)
    });
    dump_after("17_srgb_linear", &scene);
    let (w, h) = (scene.width, scene.height);
    stage("synth_srgb_gamma_encode", || {
        encode::srgb_gamma_encode(&mut scene)
    });
    // No per-pixel Look pass — #443 retired the static Look LUT (see
    // `render_from_raw_with_quality`); Auto Profile owns view-shaping.
    let bytes = stage("synth_dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
    Ok((w, h, bytes))
}
