//! WebGPU parity binding for the #925 P0 spike. Builds the same deterministic
//! buffer as the native test, runs the WGSL exposure kernel on WebGPU via
//! raw-core's shared async runner, and returns the max abs diff vs the CPU
//! oracle so the browser harness can assert the 1e-4 gate.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn exposure_gpu_parity(n_pixels: u32, ev: f32) -> Result<f32, JsError> {
    let n = n_pixels as usize;
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32;
        input.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
    }
    let gpu = raw_core::gpu::run_exposure_gpu_async(&input, ev).await;
    let mut cpu = input.clone();
    raw_core::gpu::apply_exposure_gain(&mut cpu, ev);
    let max_diff = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    Ok(max_diff)
}
