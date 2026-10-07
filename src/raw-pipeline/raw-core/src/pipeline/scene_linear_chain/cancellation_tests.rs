use crate::{pipeline::*, AdjustmentModel, CancelToken};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn film_and_window_cancel_resume_without_changing_source_or_pixels() {
    let (w, h) = (96, 80);
    let input: Vec<f32> = (0..w * h)
        .flat_map(|i| {
            [
                0.1 + (i % w) as f32 / 200.0,
                0.2 + (i / w) as f32 / 300.0,
                0.3,
                1.0,
            ]
        })
        .collect();
    let original = input.clone();
    let model = AdjustmentModel {
        exposure: 0.5,
        clarity: 10.0,
        texture: 10.0,
        nr_luminance: 25.0,
        nr_color: 25.0,
        grain_amount: 20.0,
        ..Default::default()
    };
    let lut = crate::film::FilmLut {
        size: 2,
        data: [0.3, 0.5, 0.7].repeat(8),
    };
    let flag = AtomicBool::new(false);
    let token = CancelToken::new(&flag);
    let window = ChainWindow {
        x: 0,
        y: 0,
        full_width: w,
        full_height: h,
    };
    for skip_agx in [false, true] {
        let options = ChainOptions {
            skip_agx,
            ..Default::default()
        };
        let expected =
            apply_scene_linear_chain_f32_with_film(&input, w, h, &model, &options, Some(&lut))
                .unwrap();
        let expected_window = apply_scene_linear_chain_f32_windowed(
            &input,
            w,
            h,
            &model,
            &options,
            Some(&lut),
            window,
        )
        .unwrap();
        assert_eq!(expected, expected_window);
        for cancelled in [false, true, false] {
            flag.store(cancelled, Ordering::Relaxed);
            let full = apply_scene_linear_chain_f32_with_film_cancellable(
                &input,
                w,
                h,
                &model,
                &options,
                Some(&lut),
                token,
            );
            let patch = apply_scene_linear_chain_f32_windowed_cancellable(
                &input,
                w,
                h,
                &model,
                &options,
                Some(&lut),
                window,
                token,
            );
            if cancelled {
                assert!(matches!(full, Err(crate::error::Error::Cancelled)));
                assert!(matches!(patch, Err(crate::error::Error::Cancelled)));
            } else {
                assert_eq!(full.unwrap(), expected);
                assert_eq!(patch.unwrap(), expected_window);
            }
            assert_eq!(input, original);
        }
    }
}
