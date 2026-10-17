struct Params { width: u32, height: u32, count: u32, strength: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

fn sensor_clipped(rgb: vec3<f32>) -> bool {
    return max(max(rgb.r, rgb.g), rgb.b) > 1.0 + RECOVERY_CEILING_EPSILON;
}

fn to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let lms = mul_srgb_to_lms(mul_rec2020_to_srgb(rgb));
    return mul_lms_to_lab(sign(lms) * pow(abs(lms), vec3<f32>(1.0 / 3.0)));
}

fn to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms = mul_lab_to_lms(lab);
    return mul_srgb_to_rec2020(mul_lms_to_srgb(lms * lms * lms));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let i = id.y * groups.x * 64u + id.x;
    if i >= params.count { return; }
    let pixel = input_buf[i];
    if !sensor_clipped(pixel.rgb) { output_buf[i] = pixel; return; }
    let lab = to_oklab(pixel.rgb);
    var lo = 0.0;
    var hi = 1.0;
    for (var step = 0u; step < RECOVERY_BISECTION_ITERS; step++) {
        let mid = 0.5 * (lo + hi);
        let rgb = to_rec2020(vec3<f32>(lab.x, lab.yz * mid));
        if !sensor_clipped(rgb) { lo = mid; } else { hi = mid; }
    }
    output_buf[i] = vec4<f32>(to_rec2020(vec3<f32>(lab.x, lab.yz * lo)), pixel.a);
}
