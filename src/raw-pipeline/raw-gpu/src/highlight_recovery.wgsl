struct Params { count:u32,ceiling:f32,iterations:u32,pad:u32, };
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> src:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> dst:array<vec4<f32>>;

fn to_lab(rgb:vec3<f32>)->vec3<f32> {
    let lms=mul_srgb_to_lms(mul_rec2020_to_srgb(rgb));
    return mul_lms_to_lab(sign(lms)*pow(abs(lms),vec3<f32>(1.0/3.0)));
}
fn from_lab(lab:vec3<f32>)->vec3<f32> {
    let lms=mul_lab_to_lms(lab);
    return mul_srgb_to_rec2020(mul_lms_to_srgb(lms*lms*lms));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    let i=id.x+id.y*65535u*64u;
    if i>=p.count { return; }
    let original=src[i];
    if max(max(original.r,original.g),original.b)<=p.ceiling { dst[i]=original;return; }
    let lab=to_lab(original.rgb);
    var lo=0.0;
    var hi=1.0;
    for (var step=0u;step<p.iterations;step++) {
        let mid=0.5*(lo+hi);
        let rgb=from_lab(vec3<f32>(lab.x,lab.yz*mid));
        if max(max(rgb.r,rgb.g),rgb.b)<=p.ceiling { lo=mid; } else { hi=mid; }
    }
    dst[i]=vec4<f32>(from_lab(vec3<f32>(lab.x,lab.yz*lo)),original.a);
}
