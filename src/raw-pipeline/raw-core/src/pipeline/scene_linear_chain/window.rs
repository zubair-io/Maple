use super::{f32_chain::apply_scene_linear_chain_f32_inner_cancellable, ChainOptions};
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

/// Per-edge context, in patch pixels, that a native patch must carry around
/// its published rect so every spatial stage of this chain — including the
/// frame-scaled S/H mask — sees what the full-frame chain sees (#5169).
pub fn scene_linear_chain_window_reach_px(model: &AdjustmentModel, window: ChainWindow) -> u32 {
    crate::pipeline::tile::scene_linear_chain_window_reach(
        model,
        window.full_width.max(window.full_height),
    )
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
    apply_scene_linear_chain_f32_windowed_cancellable(
        input,
        width,
        height,
        model,
        options,
        film,
        window,
        crate::CancelToken::never(),
    )
}

pub fn apply_scene_linear_chain_f32_windowed_cancellable(
    input: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    options: &ChainOptions<'_>,
    film: Option<&FilmLut>,
    window: ChainWindow,
    cancel: crate::CancelToken<'_>,
) -> Result<Vec<f32>> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
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
    if crate::stages::dehaze::any_engaged(model)
        && !options.haze_map.is_some_and(|haze| haze.covers(model))
    {
        return Err(super::haze::missing_map());
    }
    let mut options = *options;
    // Cropping changes dimensions, not sampling density. This entry's patches
    // are native-resolution and must not inherit the fit-preview NR scale.
    options.nr_sampling_scale = 1.0;
    options.mask_long_edge = Some(window.full_width.max(window.full_height));
    apply_scene_linear_chain_f32_inner_cancellable(
        input,
        width,
        height,
        model,
        &options,
        None,
        film,
        Some(window),
        cancel,
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
    fn invalid_geometry_and_an_unmapped_dehaze_window_are_explicit_errors() {
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
                .contains("haze map")
        );
    }

    /// #3287 review: on a frame above the proxy grid with a tone curve and
    /// clarity, which do not commute with a downsample, the window's map is
    /// the whole-frame chain's own, so the patch dehazes exactly as it does.
    #[test]
    fn a_large_frame_with_curves_and_clarity_windows_from_the_frames_own_map() {
        let (width, height) = (2304u32, 1536u32);
        let input: Vec<f32> = (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width, i / width);
                let veil = 0.25 + 0.55 * (1.0 - y as f32 / height as f32);
                let object = (x / 61 + y / 47) % 2 == 0;
                let fine = if (x + y) % 3 == 0 { 0.03 } else { -0.01 };
                let v = if object { 0.05 } else { 0.18 } + fine;
                [
                    v * (1.0 - veil) + 0.8 * veil,
                    v + 0.35 * veil,
                    0.65 * veil,
                    1.0,
                ]
            })
            .collect();
        let options = ChainOptions {
            whites_anchor_ev: Some(0.0),
            ..Default::default()
        };
        let model = AdjustmentModel {
            dehaze: 50.0,
            clarity: 40.0,
            tone_curve_luma: crate::types::ToneCurve::new(vec![
                (0.0, 0.0),
                (0.25, 0.14),
                (0.75, 0.86),
                (1.0, 1.0),
            ]),
            sharpen_amount: 0.0,
            nr_color: 0.0,
            nr_luminance: 0.0,
            ..Default::default()
        };
        let full =
            crate::pipeline::apply_scene_linear_chain_f32(&input, width, height, &model, &options)
                .unwrap();
        let map =
            crate::pipeline::scene_linear_chain_haze_map(&input, width, height, &model, &options)
                .unwrap()
                .expect("dehaze engaged");
        let window = ChainWindow {
            x: 1500,
            y: 700,
            full_width: width,
            full_height: height,
        };
        let reach = scene_linear_chain_window_reach_px(&model, window);
        let (px, py) = (window.x - reach, window.y - reach);
        let (pw, ph) = (160 + 2 * reach, 120 + 2 * reach);
        let patch = apply_scene_linear_chain_f32_windowed(
            &crop(&input, width, px, py, pw, ph),
            pw,
            ph,
            &model,
            &ChainOptions {
                haze_map: Some(&map),
                ..options
            },
            None,
            ChainWindow {
                x: px,
                y: py,
                ..window
            },
        )
        .unwrap();
        let expected = crop(&full, width, px, py, pw, ph);
        let worst = (reach..reach + 120)
            .flat_map(|row| (reach..reach + 160).map(move |col| (row, col)))
            .flat_map(|(row, col)| {
                let k = ((row * pw + col) * 4) as usize;
                (0..3).map(move |c| k + c)
            })
            .map(|k| (patch[k] - expected[k]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "large-frame dehaze window drifted {worst}");
    }

    /// Equal haze keys measure equal maps: dragging the last dehaze layer
    /// leaves every map, the upstream layer's included, unchanged.
    #[test]
    fn models_with_equal_haze_keys_measure_equal_maps() {
        let (width, height) = (160u32, 120u32);
        let input: Vec<f32> = (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width, i / width);
                let v = if (x / 19 + y / 13) % 2 == 0 {
                    0.07
                } else {
                    0.21
                };
                let veil = 0.3 + 0.5 * (1.0 - y as f32 / height as f32);
                [
                    v * (1.0 - veil) + 0.8 * veil,
                    v + 0.3 * veil,
                    0.6 * veil,
                    1.0,
                ]
            })
            .collect();
        let layer = |center: f32, amount: f32| {
            LocalAdjustment::radial(
                Point2::new(center, 0.5),
                Point2::new(0.3, 0.35),
                PartialAdjustments {
                    dehaze: Some(amount),
                    ..Default::default()
                },
            )
        };
        let model = |last: f32| AdjustmentModel {
            dehaze: 25.0,
            local_adjustments: vec![layer(0.35, 40.0), layer(0.65, last)],
            ..Default::default()
        };
        let measure = |m: &AdjustmentModel| {
            crate::pipeline::scene_linear_chain_haze_map(
                &input,
                width,
                height,
                m,
                &ChainOptions::default(),
            )
            .unwrap()
            .unwrap()
        };
        assert_eq!(
            crate::stages::dehaze::haze_key(&model(30.0)),
            crate::stages::dehaze::haze_key(&model(-70.0))
        );
        assert_eq!(measure(&model(30.0)), measure(&model(-70.0)));
    }

    /// With the frame's haze maps (#3287) a window recovers exactly as the
    /// whole-frame chain does over the same pixels, global and per mask.
    #[test]
    fn a_dehaze_window_with_the_frame_map_matches_the_full_frame() {
        let (width, height) = (180u32, 120u32);
        let input: Vec<f32> = (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width, i / width);
                let veil = 0.3 + 0.5 * (1.0 - y as f32 / height as f32);
                let object = (x / 23 + y / 17) % 2 == 0;
                let v = if object { 0.06 } else { 0.2 };
                [
                    v * (1.0 - veil) + 0.8 * veil,
                    v * 0.9 + 0.4 * veil,
                    0.7 * veil,
                    1.0,
                ]
            })
            .collect();
        let options = ChainOptions {
            whites_anchor_ev: Some(0.0),
            ..Default::default()
        };
        let model = AdjustmentModel {
            dehaze: 55.0,
            clarity: 20.0,
            local_adjustments: vec![LocalAdjustment::radial(
                Point2::new(0.6, 0.4),
                Point2::new(0.35, 0.3),
                PartialAdjustments {
                    dehaze: Some(-40.0),
                    ..Default::default()
                },
            )],
            sharpen_amount: 0.0,
            nr_color: 0.0,
            nr_luminance: 0.0,
            ..Default::default()
        };
        let full =
            crate::pipeline::apply_scene_linear_chain_f32(&input, width, height, &model, &options)
                .unwrap();
        let map =
            crate::pipeline::scene_linear_chain_haze_map(&input, width, height, &model, &options)
                .unwrap()
                .expect("dehaze engaged");
        let (x, y, w, h) = (40u32, 30u32, 100u32, 70u32);
        let reach = scene_linear_chain_window_reach_px(
            &model,
            ChainWindow {
                x,
                y,
                full_width: width,
                full_height: height,
            },
        );
        let (px, py) = (x - reach.min(x), y - reach.min(y));
        let (pw, ph) = (
            (x + w + reach).min(width) - px,
            (y + h + reach).min(height) - py,
        );
        let windowed = apply_scene_linear_chain_f32_windowed(
            &crop(&input, width, px, py, pw, ph),
            pw,
            ph,
            &model,
            &ChainOptions {
                haze_map: Some(&map),
                ..options
            },
            None,
            ChainWindow {
                x: px,
                y: py,
                full_width: width,
                full_height: height,
            },
        )
        .unwrap();
        let expected = crop(&full, width, px, py, pw, ph);
        let inner =
            |buf: &[f32], row: u32, col: u32| buf[((row * pw + col) * 4) as usize..][..3].to_vec();
        let worst = (y - py..y - py + h)
            .flat_map(|row| (x - px..x - px + w).map(move |col| (row, col)))
            .map(|(row, col)| {
                inner(&windowed, row, col)
                    .iter()
                    .zip(inner(&expected, row, col))
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0f32, f32::max)
            })
            .fold(0.0f32, f32::max);
        assert!(
            worst < 1e-5,
            "windowed dehaze drifted {worst} from the full frame"
        );
    }
}

#[cfg(test)]
#[path = "raster_window_tests.rs"]
mod raster_tests;
