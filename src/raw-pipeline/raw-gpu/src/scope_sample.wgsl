// Appended to present_chain.wgsl to share the actual display quantizer/noise.
// Nearest pixel-center representatives, rather than the browser's smoothed
// drawImage downsample. Quantize at ORIGINAL pixel coordinates so each sample
// is an actual presented pixel, in the chain's achieved display primaries.
@group(0) @binding(2) var<storage, read_write> scope_sample_rgba: array<u32>;

@compute @workgroup_size(64)
fn scope_sample_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let width = params.src_width;
    let height = params.src_height;
    if (id.x >= width * height) { return; }
    let x = min(u32((f32(id.x % width) + 0.5) * f32(params.width) / f32(width)), params.width - 1u);
    let y = min(u32((f32(id.x / width) + 0.5) * f32(params.height) / f32(height)), params.height - 1u);
    let color = chain_buf[y * params.width + x];
    let noise = blue_noise_offset_lsb(x, y);
    let r = u32(round(quantized_channel(color.r, noise) * 255.0));
    let g = u32(round(quantized_channel(color.g, noise) * 255.0));
    let b = u32(round(quantized_channel(color.b, noise) * 255.0));
    scope_sample_rgba[id.x] = r | (g << 8u) | (b << 16u) | (255u << 24u);
}
