// Appended to present_chain.wgsl: share its actual display quantizer and noise.
@group(0) @binding(2) var<storage, read_write> histogram_bins: array<atomic<u32>, 768>;

@compute @workgroup_size(64)
fn histogram_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let step = max(1u, (max(params.width, params.height) + 255u) / 256u);
    let columns = (params.width + step - 1u) / step;
    let rows = (params.height + step - 1u) / step;
    if (id.x >= columns * rows) { return; }
    let x = (id.x % columns) * step;
    let y = (id.x / columns) * step;
    let color = chain_buf[y * params.width + x];
    let noise = blue_noise_offset_lsb(x, y);
    let r = u32(round(quantized_channel(color.r, noise) * 255.0));
    let g = u32(round(quantized_channel(color.g, noise) * 255.0));
    let b = u32(round(quantized_channel(color.b, noise) * 255.0));
    atomicAdd(&histogram_bins[r], 1u);
    atomicAdd(&histogram_bins[256u + g], 1u);
    atomicAdd(&histogram_bins[512u + b], 1u);
}
