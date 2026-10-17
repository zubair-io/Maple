struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> noisy: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> numerator: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> denominator: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> output: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.count { return; }
    let den = denominator[i].xyz;
    let delta = numerator[i].xyz / select(vec3<f32>(1.0), den, den > vec3<f32>(0.0));
    output[i] = vec4<f32>(noisy[i].xyz + select(vec3<f32>(0.0), delta, den > vec3<f32>(0.0)), noisy[i].w);
}
