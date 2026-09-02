#![cfg(test)]

use super::*;
use crate::types::adjustment::ToneCurve;

fn img_from(pixels: Vec<[f32; 3]>) -> Image {
    let n = pixels.len() as u32;
    let mut img = Image::new(n, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels = pixels;
    img
}

#[test]
fn default_model_is_a_strict_noop() {
    let model = AdjustmentModel::default();
    let before = vec![[0.1_f32, 0.2, 0.9], [0.5, 0.5, 0.5]];
    let mut img = img_from(before.clone());
    apply(&mut img, &model);
    assert_eq!(img.pixels, before, "identity curves must not touch pixels");
}

#[test]
fn master_curve_applies_independently_per_channel_not_luma_coupled() {
    // A curve that pushes low values hard toward 1.0: (0,0) -> (0.25,1) ->
    // (1,1). Applied to a saturated-but-unequal pixel, a luma-coupled apply
    // would scale R/G/B by a SINGLE factor (preserving the R:G:B ratio); a
    // per-channel apply (Adobe's actual behaviour) does not — each channel
    // is evaluated on its own value, so the ratio changes.
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (0.25, 1.0), (1.0, 1.0)]);

    let mut img = img_from(vec![[0.1, 0.2, 0.9]]);
    apply(&mut img, &model);

    let [r, g, b] = img.pixels[0];
    assert!(r > 0.1 && g > 0.2 && b > 0.9 - 1e-4);
    assert!(
        (r / g - 0.1 / 0.2).abs() > 1e-3,
        "per-channel curve should NOT preserve the input ratio (r={r}, g={g})"
    );
}

#[test]
fn master_then_channel_curve_compose_in_order() {
    // Master: identity. Red channel: forces every input to 1.0 (single-knot
    // "constant" curve, matching `eval_curve_unit`'s single-point convention).
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_red = ToneCurve::new(vec![(0.5, 1.0)]);

    let mut img = img_from(vec![[0.2, 0.2, 0.2]]);
    apply(&mut img, &model);

    let [r, g, b] = img.pixels[0];
    assert!((r - 1.0).abs() < 1e-5, "red forced to 1.0, got {r}");
    assert_eq!(g, 0.2, "green untouched (no curve authored)");
    assert_eq!(b, 0.2, "blue untouched (no curve authored)");
}

#[test]
fn only_luma_curve_authored_applies_to_all_three_channels_identically() {
    let mut model = AdjustmentModel::default();
    // Non-trivial knot list, so a bug that skipped the master application
    // entirely still fails this on the shape check below (three curves
    // prepared from the SAME points evaluate the SAME function on each of
    // R/G/B independently).
    model.display_tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.7), (1.0, 1.0)]);

    let mut img = img_from(vec![[0.5, 0.5, 0.5]]);
    apply(&mut img, &model);

    let [r, g, b] = img.pixels[0];
    assert_eq!(r, g);
    assert_eq!(g, b);
    assert!(
        (r - 0.7).abs() < 1e-4,
        "expected curve(0.5) == 0.7, got {r}"
    );
}

#[test]
fn values_stay_clamped_to_unit_range() {
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]);

    // Out-of-range input (shouldn't occur post-AgX, but the evaluator must
    // still be a total function — no NaN/negative escape).
    let mut img = img_from(vec![[-0.1, 1.4, 0.5]]);
    apply(&mut img, &model);

    let [r, g, b] = img.pixels[0];
    assert!((0.0..=1.0).contains(&r));
    assert!((0.0..=1.0).contains(&g));
    assert!((0.0..=1.0).contains(&b));
}

#[test]
#[should_panic(expected = "DisplayLinearRec2020")]
fn wrong_color_space_panics() {
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels = vec![[0.5, 0.5, 0.5]];
    apply(&mut img, &model);
}
