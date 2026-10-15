// #4629: exact stage order/math of raw-core::color::hsm::apply_one.
// The table is already interpolated between its calibration illuminants.
// Generated color_matrices.wgsl supplies the core's HSM guard constants.
struct Params {
    dims: vec3<u32>,
    count: u32,
    srgb: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> table: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) { return; }
    let pixel = input_buf[i];
    output_buf[i] = vec4<f32>(apply_hsm(pixel.rgb), pixel.a);
}
