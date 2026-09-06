//! Shared display tail before Auto Profile; native-detail uses the same stages.
use crate::pipeline::{dump_after, stage};
use crate::{
    film,
    image::Image,
    stages::{color_grade, display_tone_curve, film_look, grain},
    view::{agx, encode},
    xmp::AdjustmentModel,
};

pub(super) fn apply(
    scene: &mut Image,
    model: &AdjustmentModel,
    film_lut: Option<&film::FilmLut>,
    target: encode::TargetPrimaries,
    window: ((u32, u32), (u32, u32)),
) {
    // View transform (#550 post-fix): AgX + gamut compress + sRGB gamma
    // encode run UNCONDITIONALLY for both Auto and Neutral. Pre-#550 the
    // Auto branch REPLACED AgX with the scene-linear curve fit, throwing
    // away AgX's hue-restoring sigmoid + ratio-preserving compression and
    // measuring an S-curve mismatch vs the camera JPEG (T8 #548: shadows
    // biased +0.16, highlights −0.16 — the lone curve could not reproduce
    // AgX's sigmoid). The Auto Profile per-channel curve now layers ON TOP
    // of AgX in f32 sRGB-encoded display space (see below), a tone residual
    // toward the JPEG distribution rather than a wholesale replacement.
    // View transform — AgX scene-referred sigmoid for every profile. Auto
    // and Neutral differ only in the Auto Profile tail layered on below;
    // the chart-fitted AcrMatch branch that used to sit here was retired in
    // #2312 (superseded by Auto's per-image embedded-JPEG fit).
    stage("agx", || agx::apply(scene, model.contrast));
    dump_after("16_agx", scene);
    // Display-referred point curves (#2232, `crs:ToneCurvePV2012*`) — run
    // immediately after AgX, before color_grade, in the display-linear
    // `[0, 1]` range AgX's own gamut compression guarantees. A DIFFERENT
    // quantity from the pre-AgX `tone_curves` stage inside `develop` — see
    // `stages::display_tone_curve`'s module docs.
    stage("display_tone_curve", || {
        display_tone_curve::apply(scene, model)
    });
    dump_after("16a0_display_tone_curve", scene);
    // Split toning (#1111, tone/zoom design § 10.3) — display-linear Oklab
    // a/b tint with a balance-shifted crossover; L untouched. Runs before
    // grain so the monochromatic noise lands on the graded image untinted.
    // Any out-of-gamut push from split-tone / grain is caught by the
    // hue-preserving Oklab compression in `rec2020_to_srgb` below (the sRGB
    // hull ⊂ the Rec.2020 working hull), so they need no separate compress
    // pass here (#1942).
    stage("color_grade", || color_grade::apply_model(scene, model));
    dump_after("16a_color_grade", scene);
    // Film emulation (epic #2683) — display-linear Rec.2020, same stage
    // position as `grain` (post-color-grade, pre-grain, so grain's noise
    // lands on the graded film result rather than being reprocessed by the
    // film print LUT). `film_lut: None` is a hard skip — no stage call, no
    // dump — so the no-look baseline stays bit-identical regardless of
    // `model.film_look` / `model.film_strength`: a host that couldn't
    // resolve the `.mlut` asset passes `None` here (see
    // `render_from_raw_with_quality_source_and_film`).
    if let Some(lut) = film_lut {
        stage("film_look", || {
            film_look::apply(scene, lut, model.film_strength)
        });
        dump_after("16a2_film_look", scene);
    }
    // Film grain (#1110, tone/zoom design § 10.2) — display-linear
    // (post-AgX, before the target gamut): grain is a display-domain
    // aesthetic; injected scene-linear its amplitude would swing with
    // exposure. Identity short-circuit at amount 0 keeps the baseline
    // bit-identical.
    stage("grain", || {
        grain::apply_windowed(
            scene,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
            window.0,
            window.1,
        )
    });
    dump_after("16b_grain", scene);
    stage("rec2020_to_srgb", || {
        encode::rec2020_to_display(scene, target)
    });
    // Buffer is in display-linear sRGB primaries here. Gamma encoding
    // happens later in `srgb_gamma_encode`. Name reflects that —
    // "srgb_linear", not "post_srgb_encode" which would have implied a
    // full sRGB encode (per PR #281 review feedback).
    dump_after("17_srgb_linear", scene);
    stage("srgb_gamma_encode", || encode::srgb_gamma_encode(scene));
}
