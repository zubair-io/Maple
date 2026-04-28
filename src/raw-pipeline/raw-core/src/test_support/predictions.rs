//! Closed-form predictors for scene-linear adjustments. Mirror the math
//! in `crate::stages::scene_tone_controls::apply` exactly so each
//! predictor + production-code pair drifts together. See spec
//! `docs/superpowers/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

/// scene_tone_controls::apply, step 1.
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    if ev.abs() < 1e-6 { return scene; }
    scene * ev.exp2()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1 image at the predicted scene-linear value, run through
    /// `scene_tone_controls::apply` with the matching slider, must produce
    /// the predictor's output to within 1e-6.
    fn round_trip_exposure(scene: f32, ev: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_exposure(scene, ev);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.exposure = ev;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_exposure({},{}) = {}, scene_tone_controls produced {} (chan {})",
                scene, ev, predicted, img.pixels[0][c], c);
        }
    }

    #[test]
    fn exposure_plus1_doubles() {
        round_trip_exposure(0.18, 1.0);
        round_trip_exposure(0.05, 1.0);
        round_trip_exposure(0.50, 1.0);
    }

    #[test]
    fn exposure_minus1_halves() {
        round_trip_exposure(0.18, -1.0);
        round_trip_exposure(0.05, -1.0);
        round_trip_exposure(0.50, -1.0);
    }

    #[test]
    fn exposure_zero_is_identity() {
        round_trip_exposure(0.18, 0.0);
    }
}
