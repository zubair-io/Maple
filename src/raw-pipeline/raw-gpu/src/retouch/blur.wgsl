@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> kernel: array<f32>;

@compute @workgroup_size(64)
fn horizontal(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.patch_size.x * params.patch_size.y { return; }
    let position = vec2<i32>(i32(i % params.patch_size.x), i32(i / params.patch_size.x));
    let half_width = i32(params.kernel_len / 2u);
    var value = vec3<f32>(0.0);
    for (var k = 0u; k < params.kernel_len; k++) {
        let x = clamp(position.x + i32(k) - half_width, 0, i32(params.patch_size.x) - 1);
        let sample_index = u32(position.y) * params.patch_size.x + u32(x);
        value += kernel[k] * input_buf[sample_index].rgb;
    }
    output_buf[i] = vec4<f32>(value, 0.0);
}

@compute @workgroup_size(64)
fn vertical(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.patch_size.x * params.patch_size.y { return; }
    let x = i % params.patch_size.x;
    let y = i32(i / params.patch_size.x);
    let half_width = i32(params.kernel_len / 2u);
    var value = vec3<f32>(0.0);
    for (var k = 0u; k < params.kernel_len; k++) {
        let row = u32(clamp(y + i32(k) - half_width, 0, i32(params.patch_size.y) - 1));
        value += kernel[k] * input_buf[row * params.patch_size.x + x].rgb;
    }
    output_buf[i] = vec4<f32>(value, 0.0);
}
