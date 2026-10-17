@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> destination_patch: array<vec4<f32>>;

fn coverage(offset: vec2<i32>) -> f32 {
    let delta = vec2<f32>(offset);
    let distance = sqrt(delta.x * delta.x + delta.y * delta.y);
    let core = params.radius * (1.0 - params.feather);
    if distance <= core { return 1.0; }
    if distance >= params.radius { return 0.0; }
    let t = clamp((distance - core) / (params.radius - core), 0.0, 1.0);
    return 1.0 - t * t * (3.0 - 2.0 * t);
}

fn pixel_offset(i: u32) -> vec2<i32> {
    return params.offset + vec2<i32>(i32(i % params.patch_size.x), i32(i / params.patch_size.x));
}

fn frame_index(position: vec2<i32>) -> u32 {
    return u32(position.y) * params.frame.x + u32(position.x);
}

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.patch_size.x * params.patch_size.y { return; }
    let offset = pixel_offset(i);
    output_buf[i] = input_buf[frame_index(params.source + offset)];
    destination_patch[i] = input_buf[frame_index(params.center + offset)];
}

@compute @workgroup_size(64)
fn composite(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.patch_size.x * params.patch_size.y { return; }
    let offset = pixel_offset(i);
    let weight = coverage(offset) * params.opacity;
    if weight <= 0.0 { return; }
    let original = destination_patch[i];
    output_buf[frame_index(params.center + offset)] = vec4<f32>(original.rgb + (input_buf[i].rgb - original.rgb) * weight, original.a);
}
