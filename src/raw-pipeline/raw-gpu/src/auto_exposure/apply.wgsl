@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> gain: vec4<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if i >= params.count { return; }
    let p = src[i];
    if abs(gain.x - 1.0) <= 1e-6 { dst[i] = p; }
    else { dst[i] = vec4<f32>(p.rgb * gain.x, p.a); }
}
