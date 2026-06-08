//! Passthrough display proof — wgpu → HTML `<canvas>` (epic #925 / P1c, #989).
//!
//! The **web counterpart** of the Apple-only [`crate::present`] module (P1b, #988):
//! proves wgpu can create a WebGPU surface from a host `<canvas>`, configure it,
//! and **present** a frame — with NO CPU readback. The presented frame is the same
//! deterministic four-quadrant test pattern (shared `present.wgsl`); distinct
//! primaries make a channel swap or gross colour-space shift obvious in-page. This
//! is PLUMBING only — the colour-correct display encode (Rec.2020→display, AgX) is
//! P2 (#990); the live Angular canvas wiring is P4-web.
//!
//! wasm-only: [`wgpu::SurfaceTarget::Canvas`] is wgpu-gated behind
//! `#[cfg(any(webgpu, webgl))]`, active on the `wasm32` target. We gate this whole
//! module on `target_arch = "wasm32"` so it compiles for the browser and is absent
//! on Apple / Linux host (which use [`crate::present`] / nothing).
//!
//! Async, not blocking: on wasm there is no `pollster::block_on` (the JS event loop
//! can't be parked). The caller awaits this future via `wasm-bindgen-futures`, the
//! same shape as P0's `exposure_gpu_parity`.
//!
//! ## Colour-space (`display-p3`)
//! The live web canvas in this project is tagged **`display-p3`** (see
//! `maple-common/.../webgl/pipeline.ts`), NOT `srgb`. Unlike P1b — where the
//! `CAMetalLayer.colorspace` is a layer property set on the Swift side, entirely
//! outside wgpu — WebGPU couples `colorSpace` *into* the `GPUCanvasContext.configure()`
//! call that wgpu owns, and wgpu-23 hardcodes it absent (→ browser default `srgb`;
//! verified in `vendor/wgpu/.../backend/webgpu.rs::surface_configure`, which never
//! sets `colorSpace`). wgpu exposes no API to plumb it through `Surface::configure`.
//!
//! So after wgpu configures the surface (as `srgb`), we re-`configure()` the *same*
//! canvas context with `colorSpace: "display-p3"`, reusing wgpu's own device +
//! format (read back via `getConfiguration()`) so the device stays consistent. The
//! reconfigure lands *before* `get_current_texture()` and `surface_get_current_texture`
//! only fetches (never re-configures — verified), so it survives to present. The
//! whole dance is done through `js_sys` on untyped values (see
//! [`crate::present_web_colorspace`]) — NOT typed `web_sys::Gpu*` bindings, which
//! would collide with wgpu-23's own vendored WebGPU bindings at link time
//! (`duplicate string enums`). It needs no unstable cfg and the present proof runs
//! regardless of whether the re-tag takes. The achieved tag (`display-p3` or
//! `srgb`) is read back and returned in [`PresentReport`] — never assumed; the
//! harness also reads it independently in plain JS and self-reports it.

use web_sys::HtmlCanvasElement;

/// The colour-space tag this project's canvases use (mirrors the live web
/// pipeline's `colorSpace: 'display-p3'`). The re-tag in
/// [`crate::present_web_colorspace`] targets this; the harness displays it as the
/// *intended* tag next to the *achieved* one (read back from `getConfiguration()`).
pub const TARGET_COLOR_SPACE: &str = "display-p3";

/// Pick the surface format: first *non-sRGB* BGRA/RGBA 8-bit the surface lists, so
/// wgpu applies no extra transfer on write (the pattern shader emits normalized
/// float RGBA; wgpu maps channel order). Mirrors the P1b
/// [`crate::present`] rationale exactly — this is a passthrough plumbing proof, not
/// a colour-managed render (that is P2).
fn pick_surface_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    use wgpu::TextureFormat::*;
    caps.formats
        .iter()
        .copied()
        .find(|f| matches!(f, Bgra8Unorm | Rgba8Unorm))
        .unwrap_or_else(|| caps.formats[0])
}

/// Outcome of a successful present, reported back to the harness so the page can
/// display exactly what happened (no eyeballing the GPU — the readback IS the
/// in-page proof, mirroring the P0 parity harness).
#[derive(Debug, Clone)]
pub struct PresentReport {
    /// The wgpu surface format chosen (e.g. `Bgra8Unorm`).
    pub format: String,
    /// The colour-space tag actually configured on the canvas context, read back
    /// from `GPUCanvasContext.getConfiguration().colorSpace`. `display-p3` if the
    /// reconfigure took, `srgb` if it didn't (or the unstable path was off), or
    /// `unknown` if the read-back API is unavailable. NEVER assumed.
    pub color_space: String,
}

/// Create a wgpu surface from `canvas`, configure it at the canvas's pixel size,
/// render the four-quadrant test pattern, present it, and report the format +
/// achieved colour-space tag. No CPU readback of the rendered frame.
///
/// Async (awaited from JS via `wasm-bindgen-futures`). Returns `Err(message)`
/// describing the first failing step so the harness can surface it in-page.
pub async fn present_test_pattern_web(canvas: HtmlCanvasElement) -> Result<PresentReport, String> {
    let width = canvas.width();
    let height = canvas.height();
    if width == 0 || height == 0 {
        return Err(format!(
            "present_test_pattern_web: canvas has zero size {width}x{height}"
        ));
    }

    let instance = wgpu::Instance::default();

    // Surface FIRST, then a surface-compatible adapter (same ordering rule as P1b).
    // `SurfaceTarget::Canvas` is the *safe* web variant — wgpu reads the canvas
    // handle itself; no `raw-window-handle` unsafe juggling needed.
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(|e| format!("create_surface(Canvas) failed: {e}"))?;

    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        })
        .await
        .ok_or_else(|| "no WebGPU adapter compatible with the canvas surface".to_string())?;

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("maple-gpu-present-web"),
                required_features: wgpu::Features::empty(),
                // WebGPU baseline. A passthrough present needs zero storage
                // buffers, so this is comfortably inside the ≤4-storage-buffer
                // rule (#925 hard constraint).
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::default(),
            },
            None,
        )
        .await
        .map_err(|e| format!("device request failed: {e}"))?;

    let caps = surface.get_capabilities(&adapter);
    if caps.formats.is_empty() {
        return Err("surface advertised no formats".to_string());
    }
    let format = pick_surface_format(&caps);

    surface.configure(
        &device,
        &wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        },
    );

    // Re-tag the canvas context to display-p3 (gated; see module docs). Runs AFTER
    // wgpu's configure and BEFORE get_current_texture, reusing wgpu's device, so it
    // survives to present without a device mismatch. Falls back silently to whatever
    // wgpu configured (srgb) when the unstable API is off / unavailable — the harness
    // reads the truth back, so a silent fallback is not a silent lie.
    let color_space = crate::present_web_colorspace::retag_display_p3(&canvas);

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("present-pattern"),
        // Same pattern shader as the Apple present proof — single-sourced.
        source: wgpu::ShaderSource::Wgsl(include_str!("present.wgsl").into()),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("present-pattern-pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let frame = surface
        .get_current_texture()
        .map_err(|e| format!("get_current_texture failed: {e}"))?;
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("present-encoder"),
    });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("present-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    // Distinct from every quadrant primary, so a failure to draw
                    // the triangle shows as this grey, not the pattern.
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.5,
                        g: 0.5,
                        b: 0.5,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1); // one fullscreen triangle, no buffers
    }

    queue.submit(Some(encoder.finish()));
    frame.present();

    Ok(PresentReport {
        format: format!("{format:?}"),
        color_space,
    })
}
