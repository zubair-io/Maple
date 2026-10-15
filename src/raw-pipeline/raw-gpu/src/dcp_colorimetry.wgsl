// #4629: camera WB, camera→ProPhoto, HSM, ProPhoto→Rec.2020, negative lift.
// hue_sat_map/math.wgsl and generated color matrices precede this kernel.
struct Params {
    dims: vec3<u32>,
    count: u32,
    srgb: u32,
    has_hsm: u32,
    _pad0: u32,
    _pad1: u32,
    gain: vec4<f32>,
    entry: array<vec4<f32>, 3>,
    exit: array<vec4<f32>, 3>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> table: array<f32>;

fn matrix_rgb(rows: array<vec4<f32>, 3>, p: vec3<f32>) -> vec3<f32> {
    // Match raw-core::Matrix3::mul_vec's row layout and arithmetic order.
    return vec3<f32>(
        rows[0].x * p.r + rows[0].y * p.g + rows[0].z * p.b,
        rows[1].x * p.r + rows[1].y * p.g + rows[1].z * p.b,
        rows[2].x * p.r + rows[2].y * p.g + rows[2].z * p.b,
    );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) { return; }
    let pixel = input_buf[i];
    var rgb = matrix_rgb(params.entry, pixel.rgb * params.gain.xyz);
    if (params.has_hsm != 0u) {
        rgb = matrix_rgb(params.exit, apply_hsm(rgb));
    }
    let lift = max(-min(min(rgb.r, rgb.g), rgb.b), 0.0);
    output_buf[i] = vec4<f32>(rgb + vec3<f32>(lift), pixel.a);
}
