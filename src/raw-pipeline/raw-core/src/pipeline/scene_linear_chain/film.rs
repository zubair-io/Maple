//! Film-aware f32 live chain for Windows (#3877). The caller owns/caches
//! the lattice; the chain borrows it without decoding or copying LUT data.
use super::{f32_chain::apply_scene_linear_chain_f32_inner_cancellable, ChainOptions};
use crate::{error::Result, film::FilmLut, xmp::AdjustmentModel};

pub fn apply_scene_linear_chain_f32_with_film(
    input: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
    film: Option<&FilmLut>,
) -> Result<Vec<f32>> {
    apply_scene_linear_chain_f32_with_film_cancellable(
        input,
        width,
        height,
        model,
        options,
        film,
        crate::CancelToken::never(),
    )
}

pub fn apply_scene_linear_chain_f32_with_film_cancellable(
    input: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
    film: Option<&FilmLut>,
    cancel: crate::CancelToken<'_>,
) -> Result<Vec<f32>> {
    apply_scene_linear_chain_f32_inner_cancellable(
        input, width, height, model, options, None, film, None, cancel,
    )
    .map(|(output, _)| output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        image::{ColorSpace, Image},
        pipeline::apply_scene_linear_chain_f32,
        stages::{film_look, grain},
    };

    fn input() -> Vec<f32> {
        (0..64)
            .flat_map(|i| [0.03 + i as f32 / 100.0, 0.12, 0.27, 1.0])
            .collect()
    }

    #[test]
    fn film_runs_after_grade_before_grain_at_zero_partial_and_full_strength() {
        let input = input();
        let options = ChainOptions::default();
        let lut = FilmLut {
            size: 2,
            data: [0.8, 0.2, 0.1].repeat(8),
        };
        let mut model = AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            split_tone_shadow_hue: 180.0,
            split_tone_shadow_saturation: 30.0,
            ..AdjustmentModel::default()
        };
        let baseline = apply_scene_linear_chain_f32(&input, 8, 8, &model, &options).unwrap();
        let mut changed = false;
        for strength in [0.0, 37.0, 100.0] {
            model.film_strength = strength;
            model.grain_amount = 25.0;
            let actual =
                apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, Some(&lut))
                    .unwrap();
            let mut expected = Image::new(8, 8, ColorSpace::DisplayLinearRec2020);
            for (pixel, rgba) in expected.pixels.iter_mut().zip(baseline.chunks_exact(4)) {
                *pixel = [rgba[0], rgba[1], rgba[2]];
            }
            film_look::apply(&mut expected, &lut, strength);
            grain::apply(
                &mut expected,
                model.grain_amount,
                model.grain_size,
                model.grain_roughness,
            );
            for (rgba, rgb) in actual.chunks_exact(4).zip(&expected.pixels) {
                for channel in 0..3 {
                    assert!((rgba[channel] - rgb[channel]).abs() < 1e-6);
                }
            }
            if strength > 0.0 {
                changed |= actual != baseline;
            }
        }
        assert!(changed, "Film must change the rendered pixels");
    }

    #[test]
    fn no_resource_and_zero_strength_are_bit_identical_and_switching_has_no_stale_lut() {
        let input = input();
        let options = ChainOptions::default();
        let mut model = AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            ..AdjustmentModel::default()
        };
        let baseline = apply_scene_linear_chain_f32(&input, 8, 8, &model, &options).unwrap();
        assert_eq!(
            baseline,
            apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, None).unwrap()
        );
        let red = FilmLut {
            size: 2,
            data: [0.8, 0.2, 0.1].repeat(8),
        };
        let blue = FilmLut {
            size: 2,
            data: [0.1, 0.2, 0.8].repeat(8),
        };
        let first =
            apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, Some(&red))
                .unwrap();
        let second =
            apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, Some(&blue))
                .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            first,
            apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, Some(&red))
                .unwrap()
        );
        model.film_strength = 0.0;
        assert_eq!(
            baseline,
            apply_scene_linear_chain_f32_with_film(&input, 8, 8, &model, &options, Some(&red))
                .unwrap()
        );
    }
}
