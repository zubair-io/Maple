@group(0) @binding(1) var<storage, read> input: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64)
fn sample_luma(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = index(id);
    if i >= p.control.z { return; }
    output[i] = bitcast<u32>(luminance(input[i * 8u].rgb));
}

