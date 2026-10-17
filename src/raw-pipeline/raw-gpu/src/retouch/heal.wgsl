@group(0) @binding(1) var<storage, read> source_patch: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> destination_low: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> source_low: array<vec4<f32>>;

@compute @workgroup_size(64)
fn replacement(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.patch_size.x * params.patch_size.y { return; }
    let source = source_patch[i].rgb;
    let low = source_low[i].rgb;
    let destination = destination_low[i].rgb;
    // Preserve zero-detail identity even when Metal reassociates the subtraction.
    let value = select(max(destination + (source - low), vec3<f32>(0.0)), max(destination, vec3<f32>(0.0)), source == low);
    source_low[i] = vec4<f32>(value, 0.0);
}
