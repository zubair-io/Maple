//! Whole-frame oracle for the raster refinement window path (#4317).
use super::*;

fn crop(input: &[f32], full_width: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<f32> {
    (y..y + h)
        .flat_map(|row| {
            let start = ((row * full_width + x) * 4) as usize;
            input[start..start + w as usize * 4].iter().copied()
        })
        .collect()
}

#[test]
fn raster_spatial_windows_match_full_frame_with_anchored_grain() {
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
    let options = ChainOptions {
        skip_agx: true,
        ..Default::default()
    };
    for exposure in [-1.0, 0.0, 1.0] {
        let model = AdjustmentModel {
            exposure,
            shadows: 30.0,
            highlights: -20.0,
            clarity: 15.0,
            texture: 10.0,
            sharpen_amount: 40.0,
            nr_luminance: 25.0,
            nr_color: 20.0,
            grain_amount: 25.0,
            ..Default::default()
        };
        crate::pipeline::validate_raster_adjustments(&model).unwrap();
        let full =
            crate::pipeline::apply_scene_linear_chain_f32(&input, width, height, &model, &options)
                .unwrap();
        for (x, y, inner_x, inner_y) in [(64, 32, 96, 96), (0, 0, 0, 0)] {
            let patch = apply_scene_linear_chain_f32_windowed(
                &crop(&input, width, x, y, 256, 256),
                256,
                256,
                &model,
                &options,
                None,
                ChainWindow {
                    x,
                    y,
                    full_width: width,
                    full_height: height,
                },
            )
            .unwrap();
            let expected = crop(&full, width, x + inner_x, y + inner_y, 64, 64);
            let actual = crop(&patch, 256, inner_x, inner_y, 64, 64);
            let max_error = actual
                .iter()
                .zip(expected)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max);
            assert!(
                max_error <= 1e-5,
                "raster window at {x},{y}, EV {exposure}: {max_error}"
            );
        }
    }
}
