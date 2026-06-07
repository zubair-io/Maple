//! Passthrough display proof — wgpu → `CAMetalLayer` (epic #925 / P1b, #988).
//!
//! Proves the second half of the #1 risk: that wgpu can create a Metal surface
//! from a host `CAMetalLayer`, configure it, and **present** a frame — with NO
//! CPU readback. The presented frame is a deterministic four-quadrant test
//! pattern (see `present.wgsl`); distinct primaries make a channel swap or gross
//! colour-space shift obvious on-device (device logs aren't capturable, so the
//! eyeball check is the proof). This is PLUMBING only — the colour-correct
//! display encode (Rec.2020→display, AgX) is P2.
//!
//! Apple-only: the surface variant is `wgpu::SurfaceTargetUnsafe::CoreAnimationLayer`,
//! which wgpu gates behind `#[cfg(metal)]`. We gate this whole module on
//! `target_vendor = "apple"` so it compiles for the four Apple slices (where the
//! metal backend is active) and is absent everywhere else (wasm, Linux host).
//!
//! Self-contained one-shot: it owns its own instance/adapter/device/surface
//! rather than borrowing [`crate::GpuContext`] (which requests its adapter with
//! no `compatible_surface`). It draws exactly once and returns — no redraw loop
//! (a CADisplayLink-style loop is P4 live-edit territory, out of scope here).

use std::ffi::c_void;

/// Format the surface is configured with. We pick the first *non-sRGB* BGRA/RGBA
/// 8-bit format the surface advertises (Metal's default is `Bgra8Unorm`). The
/// pattern shader emits normalized float RGBA, so wgpu handles the channel
/// byte-order — we don't depend on BGRA vs RGBA. We deliberately avoid the
/// `*Srgb` variants so wgpu applies no extra transfer function on write: P1b is
/// a passthrough plumbing proof, not a colour-managed render (that is P2). The
/// CAMetalLayer's `colorspace` tag is set explicitly on the Swift side and is
/// the authoritative colour-space declaration for this proof.
fn pick_surface_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    use wgpu::TextureFormat::*;
    caps.formats
        .iter()
        .copied()
        .find(|f| matches!(f, Bgra8Unorm | Rgba8Unorm))
        // Fall back to whatever the surface lists first if neither plain 8-bit
        // UNORM is offered (shouldn't happen on Metal, but stay robust).
        .unwrap_or_else(|| caps.formats[0])
}

/// Create a wgpu surface from `layer` (a `CAMetalLayer*`), configure it at
/// `width × height`, render the four-quadrant test pattern, and present it.
/// Native-blocking (drives the async adapter/device requests via pollster).
///
/// Returns `Ok(())` on a successful present, or an `Err(message)` describing the
/// first failing step (no adapter, device request failed, surface texture
/// acquisition failed, …) so the caller can surface it in-app.
///
/// # Safety
/// `layer` must be a valid, non-null `CAMetalLayer*` that outlives this call.
/// The surface created from it is dropped before this function returns, so the
/// layer need not outlive the *return* — only the call. The caller (the Swift
/// `UIViewRepresentable` / `NSViewRepresentable`) owns the layer's lifetime.
pub unsafe fn present_test_pattern(
    layer: *mut c_void,
    width: u32,
    height: u32,
) -> Result<(), String> {
    pollster::block_on(present_test_pattern_async(layer, width, height))
}

async unsafe fn present_test_pattern_async(
    layer: *mut c_void,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if layer.is_null() {
        return Err("present_test_pattern: layer pointer is null".to_string());
    }
    if width == 0 || height == 0 {
        return Err(format!(
            "present_test_pattern: invalid surface size {width}x{height}"
        ));
    }

    let instance = wgpu::Instance::default();

    // Surface FIRST, then a surface-compatible adapter. Requesting the adapter
    // before the surface is the classic wgpu gotcha — you can land on an adapter
    // the surface doesn't support. On Metal `compatible_surface` is
    // belt-and-suspenders (one adapter), but it's the correct ordering.
    // SAFETY: `layer` is a valid CAMetalLayer* per this fn's contract; the
    // resulting surface is used and dropped entirely within this call.
    let surface = instance
        .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
        .map_err(|e| format!("create_surface_unsafe failed: {e}"))?;

    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        })
        .await
        .ok_or_else(|| "no GPU adapter compatible with the CAMetalLayer surface".to_string())?;

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("maple-gpu-present"),
                required_features: wgpu::Features::empty(),
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

    // Fullscreen-triangle pattern pipeline. One shader module, vs+fs.
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("present-pattern"),
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
                    // A clear colour distinct from every quadrant primary, so a
                    // failure to actually draw the triangle is visible (the
                    // screen would be this grey, not the pattern).
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
    Ok(())
}
