use super::*;

#[test]
fn live_chain_sampled_sharpen_matches_cpu() {
    let (w, h) = (32, 32);
    let input = scene_linear_rgba(w, h);
    let mut case = neutral_case();
    case.model.sharpen_amount = 75.0;
    case.model.sharpen_radius = 2.0;
    let mut inputs = case.gpu_inputs_for(&input);
    for scale in [0.25, 0.5, 1.0] {
        inputs.nr_sampling_scale = scale;
        let actual = run_live_chain(&input, w as u32, h as u32, &inputs);
        let mut image = raw_core::image::Image::new(
            w as u32,
            h as u32,
            raw_core::image::ColorSpace::SceneLinearRec2020,
        );
        image.nr_sampling_scale = scale;
        image.pixels = input.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect();
        raw_core::stages::sharpen::apply(
            &mut image,
            75.0,
            raw_core::stages::sharpen::radius_at_scale(2.0, scale),
            case.model.sharpen_detail,
            case.model.sharpen_masking,
        );
        let prepared: Vec<f32> = image
            .pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 1.0])
            .collect();
        let expected = cpu_oracle(&prepared, w as u32, h as u32, &neutral_case());
        assert!(max_abs_diff(&actual, &expected) < 1e-4, "scale={scale}");
        // Full composition also consumes the density, independent of live gating.
        let full = run_ungated_chain(&input, w as u32, h as u32, &inputs);
        let mut equivalent = case.gpu_inputs_for(&input);
        equivalent.nr_sampling_scale = 1.0;
        equivalent.sharpen_radius = if scale == 0.25 { 0.5 } else { 2.0 * scale };
        let full_expected = run_ungated_chain(&input, w as u32, h as u32, &equivalent);
        assert!(
            max_abs_diff(&full, &full_expected) < 1e-6,
            "full scale={scale}"
        );
    }
}

#[test]
fn live_chain_forwards_nr_sampling_scale() {
    let (w, h) = (48, 48);
    let input = scene_linear_rgba(w, h);
    let mut case = neutral_case();
    case.model.nr_color = 75.0;
    let mut inputs = case.gpu_inputs_for(&input);
    inputs.nr_sampling_scale = 0.25;
    let actual = run_live_chain(&input, w as u32, h as u32, &inputs);
    let mut image = raw_core::image::Image::new(
        w as u32,
        h as u32,
        raw_core::image::ColorSpace::SceneLinearRec2020,
    );
    image.pixels = input.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect();
    raw_core::stages::noise_reduction::apply_color_sampled_cancellable(
        &mut image,
        75.0,
        raw_core::cancel::CancelToken::never(),
        None,
        100,
        0.25,
    );
    let prepared: Vec<f32> = image
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    case.model.nr_color = 0.0;
    let expected = cpu_oracle(&prepared, w as u32, h as u32, &case);
    assert!(max_abs_diff(&actual, &expected) < 1e-4);
    inputs.nr_sampling_scale = 1.0;
    let native = run_live_chain(&input, w as u32, h as u32, &inputs);
    assert!(max_abs_diff(&actual, &native) > 1e-5);
}
