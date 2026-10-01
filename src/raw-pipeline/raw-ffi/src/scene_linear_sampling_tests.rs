//! #3875: exercise sampling metadata through the real C-ABI chain entry.
use crate::scene_linear_chain::maple_apply_scene_linear_chain_f32;
use crate::scene_linear_chain_tests::default_params;
use raw_core::{
    cancel::CancelToken,
    image::{ColorSpace, Image},
    stages::noise_reduction,
};

fn input() -> Vec<f32> {
    (0..32 * 24)
        .flat_map(|i| {
            let x = (i % 32) as f32;
            let y = (i / 32) as f32;
            [
                0.2 + 0.015 * (x * 1.7 + y).sin(),
                0.2 + 0.012 * (y * 2.1 - x).cos(),
                0.2 + 0.018 * (x * 0.7 + y * 1.3).sin(),
                1.0,
            ]
        })
        .collect()
}

fn render(input: &[f32], scale: f32) -> Vec<f32> {
    let mut params = default_params();
    params.nr_color = 75.0;
    params.nr_sampling_scale = scale;
    let mut output = vec![0.0; input.len()];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(input.as_ptr(), 32, 24, &params, output.as_mut_ptr())
    };
    assert_eq!(rc, 0);
    output
}

#[test]
fn ffi_forwards_preview_sampling_to_chroma_nr() {
    let input = input();
    let mut expected = Image::new(32, 24, ColorSpace::SceneLinearRec2020);
    expected.pixels = input.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect();
    noise_reduction::apply_color_sampled_cancellable(
        &mut expected,
        75.0,
        CancelToken::never(),
        None,
        0,
        0.25,
    );
    let actual = render(&input, 0.25);
    for (pixel, expected) in actual.chunks_exact(4).zip(expected.pixels) {
        for channel in 0..3 {
            assert!((pixel[channel] - expected[channel]).abs() < 1e-6);
        }
        assert_eq!(pixel[3], 1.0);
    }
    let native = render(&input, 1.0);
    assert!(
        actual.iter().zip(native).any(|(a, b)| (a - b).abs() > 1e-5),
        "Fixture must detect dropped sampling metadata"
    );
}

#[test]
fn ffi_missing_or_invalid_sampling_preserves_native_nr() {
    let input = input();
    let native = render(&input, 1.0);
    for scale in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert_eq!(render(&input, scale), native, "scale={scale}");
    }
}
