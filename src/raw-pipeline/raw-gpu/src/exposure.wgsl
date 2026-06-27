// exposure.wgsl — scene-linear exposure gain: rgb *= 2^ev, alpha untouched.
// One WGSL source for Metal (Apple) and WebGPU (web). Parity oracle:
// raw-gpu::apply_exposure_gain (CPU). Epic #925 (P0 spike → P1a substrate).

struct Params {
    ev: f32,
    count: u32,   // number of RGBA pixels
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let gain = exp2(params.ev);
    let p = input_buf[i];
    output_buf[i] = vec4<f32>(p.rgb * gain, p.a);
}
