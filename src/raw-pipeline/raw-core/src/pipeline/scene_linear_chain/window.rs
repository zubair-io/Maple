use super::{apply_scene_linear_chain_f32_inner, ChainOptions};
use crate::{
    error::{Error, Result},
    film::FilmLut,
    xmp::AdjustmentModel,
};

#[derive(Clone, Copy, Debug)]
pub struct ChainWindow {
    pub x: u32,
    pub y: u32,
    pub full_width: u32,
    pub full_height: u32,
}

/// #3876 native-detail patches include the spatial filter halo; callers trim
/// that halo after this chain. Coordinates refer to the oriented full image.
pub fn apply_scene_linear_chain_f32_windowed(
    input: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
    film: Option<&FilmLut>,
    window: ChainWindow,
) -> Result<Vec<f32>> {
    if width == 0
        || height == 0
        || window.x >= window.full_width
        || window.y >= window.full_height
        || width > window.full_width - window.x
        || height > window.full_height - window.y
        || window.full_width > i32::MAX as u32
        || window.full_height > i32::MAX as u32
    {
        return Err(Error::Pipeline(
            "native detail window is outside the full image".into(),
        ));
    }
    if model.dehaze.abs() > 1e-3
        || crate::stages::local_adjustments::spatial::any_dehaze_engaged(&model.local_adjustments)
    {
        return Err(Error::Pipeline(
            "native detail requires a full-frame dehaze proxy".into(),
        ));
    }
    let mut options = *options;
    options.mask_long_edge = Some(window.full_width.max(window.full_height));
    apply_scene_linear_chain_f32_inner(
        input,
        width,
        height,
        model,
        &options,
        None,
        film,
        Some(window),
    )
    .map(|(output, _)| output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LocalAdjustment, PartialAdjustments, Point2};

    fn crop(input: &[f32], full_width: u32, x: u32, y: u32, width: u32, height: u32) -> Vec<f32> {
        (y..y + height)
            .flat_map(|row| {
                let start = ((row * full_width + x) * 4) as usize;
                input[start..start + width as usize * 4].iter().copied()
            })
            .collect()
    }

    #[test]
    fn masks_vignette_grain_and_film_match_the_full_frame_at_each_window_origin() {
        let (width, height) = (96, 80);
        let input: Vec<f32> = (0..width * height)
            .flat_map(|i| {
                [
                    0.05 + (i % width) as f32 / 170.0,
                    0.12 + (i / width) as f32 / 250.0,
                    0.23,
                    1.0,
                ]
            })
            .collect();
        let options = ChainOptions {
            whites_anchor_ev: Some(0.0),
            ..Default::default()
        };
        let film = FilmLut {
            size: 2,
            data: [0.2, 0.4, 0.1].repeat(8),
        };
        let model = AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            nr_luminance: 0.0,
            vignette_amount: -45.0,
            grain_amount: 35.0,
            film_strength: 37.0,
            local_adjustments: vec![LocalAdjustment::radial(
                Point2::new(0.7, 0.3),
                Point2::new(0.4, 0.5),
                PartialAdjustments {
                    exposure: Some(-1.0),
                    ..Default::default()
                },
            )],
            ..Default::default()
        };
        let full = super::super::apply_scene_linear_chain_f32_with_film(
            &input,
            width,
            height,
            &model,
            &options,
            Some(&film),
        )
        .unwrap();
        let without = super::super::apply_scene_linear_chain_f32(
            &input,
            width,
            height,
            &AdjustmentModel {
                sharpen_amount: 0.0,
                nr_color: 0.0,
                ..Default::default()
            },
            &options,
        )
        .unwrap();
        assert_ne!(full, without);
        for (x, y) in [(0, 0), (55, 0), (0, 51), (55, 51), (21, 27)] {
            let window = ChainWindow {
                x,
                y,
                full_width: width,
                full_height: height,
            };
            let actual = apply_scene_linear_chain_f32_windowed(
                &crop(&input, width, x, y, 41, 29),
                41,
                29,
                &model,
                &options,
                Some(&film),
                window,
            )
            .unwrap();
            assert_eq!(actual, crop(&full, width, x, y, 41, 29));
        }
    }

    #[test]
    fn spatial_patch_interior_matches_full_chain_with_filter_halo() {
        let (width, height) = (384, 320);
        let input: Vec<f32> = (0..width * height)
            .flat_map(|i| {
                let x = (i % width) as f32;
                let y = (i / width) as f32;
                [
                    0.2 + 0.06 * (x * 0.3).sin(),
                    0.3 + 0.08 * (y * 0.2).cos(),
                    0.1 + 0.04 * ((x + y) * 0.7).sin(),
                    1.0,
                ]
            })
            .collect();
        let model = AdjustmentModel {
            shadows: 30.0,
            highlights: -20.0,
            clarity: 15.0,
            texture: 10.0,
            sharpen_amount: 40.0,
            nr_color: 20.0,
            ..Default::default()
        };
        let options = ChainOptions {
            whites_anchor_ev: Some(0.0),
            ..Default::default()
        };
        let full =
            super::super::apply_scene_linear_chain_f32(&input, width, height, &model, &options)
                .unwrap();
        let patch = apply_scene_linear_chain_f32_windowed(
            &crop(&input, width, 64, 32, 256, 256),
            256,
            256,
            &model,
            &options,
            None,
            ChainWindow {
                x: 64,
                y: 32,
                full_width: width,
                full_height: height,
            },
        )
        .unwrap();
        let expected = crop(&full, width, 160, 128, 64, 64);
        let actual = crop(&patch, 256, 96, 96, 64, 64);
        let max_error = actual
            .iter()
            .zip(expected)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_error <= 1e-5, "halo interior differs by {max_error}");
    }

    #[test]
    fn invalid_geometry_and_global_dehaze_are_explicit_errors() {
        let options = ChainOptions::default();
        let mut model = AdjustmentModel::default();
        let mut window = ChainWindow {
            x: u32::MAX,
            y: 0,
            full_width: 100,
            full_height: 100,
        };
        assert!(
            apply_scene_linear_chain_f32_windowed(&[], 2, 2, &model, &options, None, window)
                .unwrap_err()
                .to_string()
                .contains("outside")
        );
        window.x = 0;
        model.dehaze = 10.0;
        assert!(
            apply_scene_linear_chain_f32_windowed(&[], 2, 2, &model, &options, None, window)
                .unwrap_err()
                .to_string()
                .contains("dehaze proxy")
        );
    }
}
