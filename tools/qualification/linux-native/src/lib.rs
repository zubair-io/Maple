//! Shared compute correctness gate; readbacks are qualification-only.
use raw_gpu::{apply_exposure_gain, ChainRunner, ExposurePass, GpuContext, GpuImage};

pub fn verify_exposure(gpu: &GpuContext) -> Result<(), String> {
    let pixels: Vec<f32> = (0..256)
        .flat_map(|i| {
            let value = i as f32 / 64.0 - 0.25;
            [value, value * 0.5, value * 0.25, 1.0]
        })
        .collect();
    let image = GpuImage::upload(gpu, &pixels, 16, 16);
    let runner = ChainRunner::new(gpu, &image);
    for ev in [-4.0, 0.0, 1.0, 4.0] {
        let mut expected = pixels.clone();
        apply_exposure_gain(&mut expected, ev);
        // Readback belongs to this correctness probe only, never the editor tick.
        let actual = runner.run_blocking(&[&ExposurePass { ev }]);
        let max_error = actual
            .iter()
            .zip(&expected)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        if actual.len() != expected.len()
            || actual.iter().any(|v| !v.is_finite())
            || max_error > 0.00001
        {
            return Err(format!(
                "Exposure parity failed at {ev} EV: max error {max_error}"
            ));
        }
        println!("exposure_ev={ev} max_error={max_error}");
    }
    Ok(())
}
