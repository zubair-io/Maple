@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if i >= params.count { return; }
    let p = src[i];
    let y = AE_LUMA.x * p.r + AE_LUMA.y * p.g + AE_LUMA.z * p.b;
    let bits = bitcast<u32>(select(y, 0.0, y == 0.0));
    // Nonfinite luminance is filtered exactly as in the CPU rank population.
    if (bits & 0x7f800000u) == 0x7f800000u { keys[i] = 0xffffffffu; return; }
    keys[i] = select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}
