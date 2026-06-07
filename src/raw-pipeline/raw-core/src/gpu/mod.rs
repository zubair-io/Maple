//! GPU compute spike (epic #925, P0). Feature-gated behind `gpu` (OFF by
//! default). Proves one stage (exposure: `rgb *= 2^ev`) runs GPU-resident via
//! wgpu+WGSL and matches the Rust CPU oracle within 1e-4. The CPU path in
//! `raw-core` stays the parity oracle and fallback.

/// Scene-linear exposure gain on an interleaved RGBA f32 buffer:
/// `rgb *= 2^ev`, alpha untouched. This is the spike's CPU oracle — it mirrors
/// the `baseline_exposure.exp2()` multiply in `pipeline::develop` (and the
/// additive-EV user exposure), kept standalone so the spike isolates GPU
/// plumbing rather than pipeline integration.
pub fn apply_exposure_gain(buf: &mut [f32], ev: f32) {
    let gain = ev.exp2();
    for px in buf.chunks_exact_mut(4) {
        px[0] *= gain;
        px[1] *= gain;
        px[2] *= gain;
        // px[3] (alpha) untouched
    }
}

/// Native blocking entry: run the WGSL exposure kernel on the default adapter
/// (Metal on macOS) and return the result buffer. macOS→Metal is the P0 macOS
/// validation. Not compiled for wasm (which awaits the async fn directly).
#[cfg(not(target_arch = "wasm32"))]
pub fn run_exposure_gpu(input: &[f32], ev: f32) -> Vec<f32> {
    pollster::block_on(run_exposure_gpu_async(input, ev))
}

/// Shared async runner used by the native test (via pollster) and the wasm
/// binding (via wasm-bindgen-futures). GPU-resident: upload → dispatch → one
/// readback (readback is test/export-only, never the interactive path).
pub async fn run_exposure_gpu_async(input: &[f32], ev: f32) -> Vec<f32> {
    use wgpu::util::DeviceExt;

    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("no suitable GPU adapter");
    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("maple-gpu-spike"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::default(),
            },
            // wgpu 23.0.1 still takes the trace-path arg (the plan's note
            // assumed it was dropped in v22; this patch keeps it). `None`
            // disables API tracing.
            None,
        )
        .await
        .expect("device request failed");

    let pixel_count = (input.len() / 4) as u32;

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct Params {
        ev: f32,
        count: u32,
        _pad0: u32,
        _pad1: u32,
    }
    let params = Params {
        ev,
        count: pixel_count,
        _pad0: 0,
        _pad1: 0,
    };

    let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let input_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("input"),
        contents: bytemuck::cast_slice(input),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let byte_len = std::mem::size_of_val(input) as u64;
    let output_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("output"),
        size: byte_len,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("exposure"),
        source: wgpu::ShaderSource::Wgsl(include_str!("exposure.wgsl").into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("exposure-pipeline"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("exposure-bg"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: input_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output_buf.as_entire_binding(),
            },
        ],
    });

    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("exposure-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        let workgroups = pixel_count.div_ceil(64);
        pass.dispatch_workgroups(workgroups, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buf, 0, &readback_buf, 0, byte_len);
    queue.submit(Some(encoder.finish()));

    let slice = readback_buf.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    // Native: drive the queue to completion. On wasm this is a no-op and the
    // await below resolves when the browser completes the map.
    #[cfg(not(target_arch = "wasm32"))]
    device.poll(wgpu::Maintain::Wait);
    rx.await
        .expect("map channel dropped")
        .expect("buffer map failed");

    let data = slice.get_mapped_range();
    let out: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback_buf.unmap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_gain_doubles_rgb_at_plus_one_ev_and_keeps_alpha() {
        // Two RGBA pixels. +1 EV → gain = 2^1 = 2.0.
        let mut buf = vec![0.1, 0.2, 0.4, 1.0, 0.5, 0.5, 0.5, 0.3];
        apply_exposure_gain(&mut buf, 1.0);
        assert!((buf[0] - 0.2).abs() < 1e-6);
        assert!((buf[1] - 0.4).abs() < 1e-6);
        assert!((buf[2] - 0.8).abs() < 1e-6);
        assert!((buf[3] - 1.0).abs() < 1e-6, "alpha untouched");
        assert!((buf[4] - 1.0).abs() < 1e-6);
        assert!((buf[7] - 0.3).abs() < 1e-6, "alpha untouched");
    }

    /// Deterministic RGBA buffer spanning values < 1, = 1, > 1 (some channels
    /// exceed 1 so the multiply is exercised in scene-linear range).
    fn test_buffer(n: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(n * 4);
        for i in 0..n {
            let t = i as f32 / (n.max(2) - 1) as f32; // 0..=1
            v.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
        }
        v
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wgsl_exposure_matches_cpu_oracle_within_1e_4() {
        let input = test_buffer(256);
        for &ev in &[-3.0_f32, 0.0, 0.5, 4.0] {
            let mut cpu = input.clone();
            apply_exposure_gain(&mut cpu, ev);
            let gpu = run_exposure_gpu(&input, ev);
            let max_diff = cpu
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            eprintln!("PARITY ev={ev}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "ev={ev}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }
}
