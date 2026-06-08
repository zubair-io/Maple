//! WebGPU bindings for epic #925.
//!
//! - [`exposure_gpu_parity`] (P0): builds the same deterministic buffer as the
//!   native test, runs the WGSL exposure kernel on WebGPU via the `raw-gpu`
//!   resource core's shared async runner, and returns the max abs diff vs the CPU
//!   oracle so the browser harness can assert the 1e-4 gate.
//! - [`present_gpu`] (P1c / #989): creates a WebGPU surface from an HTML `<canvas>`
//!   and presents a deterministic four-quadrant test pattern with no CPU readback —
//!   the web counterpart of the Apple P1b `CAMetalLayer` present proof. Returns the
//!   chosen surface format + the achieved canvas colour-space tag for in-page
//!   self-reporting.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn exposure_gpu_parity(n_pixels: u32, ev: f32) -> Result<f32, JsError> {
    let n = n_pixels as usize;
    let mut input = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32;
        input.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
    }
    let gpu = raw_gpu::run_exposure_gpu_async(&input, ev).await;
    let mut cpu = input.clone();
    raw_gpu::apply_exposure_gain(&mut cpu, ev);
    let max_diff = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    Ok(max_diff)
}

/// Result of a successful web present (P1c / #989), returned to JS so the harness
/// page can display exactly what the GPU did — there is no readback of the frame,
/// so this struct IS the in-page proof (mirroring P0's numeric parity readout).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(getter_with_clone)]
pub struct PresentResult {
    /// The wgpu surface format configured (e.g. `"Bgra8Unorm"`).
    pub format: String,
    /// The colour-space tag actually configured on the canvas context, read back
    /// from `GPUCanvasContext.getConfiguration().colorSpace`. `"display-p3"` when
    /// the wide-gamut re-tag took (needs a `web_sys_unstable_apis` build + a browser
    /// that supports `getConfiguration`), `"srgb"` otherwise. Never assumed.
    #[wasm_bindgen(js_name = colorSpace)]
    pub color_space: String,
}

/// Present the four-quadrant test pattern to `canvas` via WebGPU (P1c / #989).
///
/// The web analog of the Apple `present_test_pattern` (P1b): creates a
/// `wgpu::Surface` from the `<canvas>`, configures it, renders the shared
/// `present.wgsl` pattern, and presents — with NO CPU readback. Awaited from JS.
///
/// Returns a [`PresentResult`] (format + achieved colour-space tag) on success, or
/// rejects with the failing step's message so the harness can show it in-page.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn present_gpu(canvas: web_sys::HtmlCanvasElement) -> Result<PresentResult, JsError> {
    let report = raw_gpu::present_test_pattern_web(canvas)
        .await
        .map_err(|e| JsError::new(&e))?;
    Ok(PresentResult {
        format: report.format,
        color_space: report.color_space,
    })
}
