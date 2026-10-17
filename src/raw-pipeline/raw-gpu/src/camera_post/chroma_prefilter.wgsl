struct Params { width: u32, height: u32, count: u32, strength: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

fn luminance(rgb: vec3<f32>) -> f32 {
    return CHROMA_LUMA.x * rgb.x + CHROMA_LUMA.y * rgb.y + CHROMA_LUMA.z * rgb.z;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.count { return; }
    let pixel = input_buf[i];
    if params.strength < 1e-3 { output_buf[i] = pixel; return; }
    let sigma = CHROMA_SIGMA_MAX_REL * (min(params.strength, 100.0) / 100.0);
    let y_center = luminance(pixel.rgb);
    let chroma_center = pixel.rb - vec2<f32>(y_center);
    let location = vec2<i32>(i32(i % params.width), i32(i / params.width));
    var numerator = vec2<f32>(0.0);
    var denominator = 1.0;
    var uniform = true;
    for (var k = 0u; k < 8u; k++) {
        let neighbor = location + CHROMA_TAPS[k];
        if any(neighbor < vec2<i32>(0)) || any(neighbor >= vec2<i32>(i32(params.width), i32(params.height))) { continue; }
        let sample = input_buf[u32(neighbor.y) * params.width + u32(neighbor.x)].rgb;
        uniform = uniform && all(sample == pixel.rgb);
        let y_sample = luminance(sample);
        let scale = 0.5 * (y_center + y_sample) + CHROMA_PEDESTAL;
        let t = (y_sample - y_center) / (sigma * scale);
        let weight = CHROMA_SPATIAL_WEIGHTS[k] * (1.0 / (1.0 + t * t));
        numerator += weight * ((sample.rb - vec2<f32>(y_sample)) - chroma_center);
        denominator += weight;
    }
    // Preserve exact uniform fields even when a backend reassociates the chroma subtraction.
    if uniform { output_buf[i] = pixel; return; }
    var delta = numerator / denominator;
    let filtered = chroma_center + delta;
    let original_magnitude = chroma_center.x * chroma_center.x + chroma_center.y * chroma_center.y;
    let filtered_magnitude = filtered.x * filtered.x + filtered.y * filtered.y;
    if filtered_magnitude > original_magnitude {
        var scale = 0.0;
        if filtered_magnitude > 0.0 { scale = sqrt(original_magnitude / filtered_magnitude); }
        delta = filtered * scale - chroma_center;
    }
    let green_delta = -(CHROMA_LUMA.x * delta.x + CHROMA_LUMA.z * delta.y) / CHROMA_LUMA.y;
    output_buf[i] = vec4<f32>(pixel.r + delta.x, pixel.g + green_delta, pixel.b + delta.y, pixel.a);
}
