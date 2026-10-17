use super::*;
use raw_gpu::{
    encode_bm3d_filter_row, encode_bm3d_match_row, pool_data_storage, GpuBm3dFilteredRow,
    GpuContext,
};

fn bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_ne_bytes()).collect()
}

fn packed(planes: &[Vec<f32>; 3]) -> Vec<f32> {
    (0..planes[0].len())
        .flat_map(|i| [planes[0][i], planes[1][i], planes[2][i], 0.])
        .collect()
}

fn compare_rows(
    ctx: &GpuContext,
    noisy: &[Vec<f32>; 3],
    basic: Option<&[Vec<f32>; 3]>,
    dims: (usize, usize),
    sigmas: [f32; 3],
    tau: f32,
) {
    let (width, height) = dims;
    let source = pool_data_storage(ctx, &bytes(&packed(noisy)), "bm3d-filter-test-noisy");
    let guide = basic.map(|b| pool_data_storage(ctx, &bytes(&packed(b)), "bm3d-filter-test-basic"));
    let luma = pool_data_storage(
        ctx,
        &bytes(&basic.unwrap_or(noisy)[0]),
        "bm3d-filter-test-luma",
    );
    let parameters = pool_data_storage(
        ctx,
        &bytes(&[tau, sigmas[0], sigmas[1], sigmas[2]]),
        "bm3d-filter-test-parameters",
    );
    let mut compared = 0;
    let mut max_error = 0f32;
    for ry in matching::ref_coords(height) {
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        let matches = encode_bm3d_match_row(
            ctx,
            &mut encoder,
            &luma,
            &parameters,
            (width as u32, height as u32),
            ry as u32,
        );
        let filtered = encode_bm3d_filter_row(
            ctx,
            &mut encoder,
            &source,
            guide.as_deref(),
            &matches,
            (width as u32, height as u32),
        );
        ctx.queue.submit(Some(encoder.finish()));
        let actual = filtered.read_back_blocking(ctx);
        for (column, rx) in matching::ref_coords(width).iter().enumerate() {
            let positions =
                matching::find_group(&basic.unwrap_or(noisy)[0], width, height, *rx, ry, tau);
            for channel in 0..3 {
                let (mut spectra, mut means, reference) =
                    pipeline::group_spectra(&noisy[channel], width, &positions);
                let g = basic.map(|b| pipeline::group_spectra(&b[channel], width, &positions));
                let weight = pipeline::shrink_group(
                    &mut spectra,
                    &mut means,
                    g.as_ref().map(|v| (v.0.as_slice(), v.1.as_slice())),
                    sigmas[channel],
                    sigmas[channel] / (BLOCK as f32),
                );
                let offset = (column * 3 + channel) * GpuBm3dFilteredRow::RECORD_WORDS;
                let gpu_weight = actual[offset];
                assert!(
                    (gpu_weight - weight).abs() <= 1e-4 * weight.abs().max(1.),
                    "weight {gpu_weight} vs {weight} at {rx}/{ry} ch {channel}"
                );
                for (member, spectrum) in spectra.iter_mut().enumerate() {
                    transforms::dct2d_inverse(spectrum);
                    let mean = reference + means[member];
                    for (pixel, residual) in spectrum.iter().enumerate() {
                        let expected = residual + mean;
                        let (px, py) = positions[member];
                        let original =
                            noisy[channel][(py + pixel / BLOCK) * width + px + pixel % BLOCK];
                        let value = actual[offset + 4 + member * BLOCK * BLOCK + pixel]
                            / gpu_weight
                            + original;
                        let error = (value - expected).abs();
                        max_error = max_error.max(error);
                        assert!(error <= 1e-4, "pixel error {error} ({value}/{expected}), {dims:?} at {rx}/{ry}, ch{channel}, member{member}, pixel{pixel}, wiener{}", basic.is_some());
                        compared += 1;
                    }
                }
            }
        }
    }
    eprintln!(
        "BM3D filter {width}x{height} wiener={}: {compared} pixels, max={max_error}",
        basic.is_some()
    );
}

#[test]
fn gpu_hard_and_wiener_filters_match_cpu_groups() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h) in [(8, 8), (9, 12), (23, 19)] {
        for kind in 0..3 {
            let noisy = std::array::from_fn(|channel| {
                (0..w * h)
                    .map(|i| {
                        let base = [0.18, -0.03, 0.07][channel];
                        match kind {
                            0 => base,
                            1 => base + (i % w) as f32 * 0.02 - (i / w) as f32 * 0.015,
                            _ => base + ((i * 31 + channel * 17) % 127) as f32 / 31. - 0.2,
                        }
                    })
                    .collect()
            });
            for (sigmas, tau) in [
                ([0.02, 0.036, 0.036], 0.0025),
                ([0.2, 0.36, 0.36], f32::INFINITY),
            ] {
                compare_rows(&ctx, &noisy, None, (w, h), sigmas, tau);
                let basic = pipeline::run_pass(
                    &noisy,
                    w,
                    h,
                    sigmas,
                    tau,
                    pipeline::PassKind::Hard,
                    PASS_1,
                    None,
                    &|| false,
                )
                .unwrap();
                compare_rows(&ctx, &noisy, Some(&basic), (w, h), sigmas, tau);
            }
        }
    }
}
