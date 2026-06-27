// scene_tone_sh.wgsl — masked shadows/highlights step (#1103, tone-zoom § 4.2).
//
// One dispatch applies ONE of the two reworked tone steps (params.mode selects
// highlights or shadows) through the tonal detail mask:
//
//   Y    = dot(LUMA_REC2020, src[i].rgb)        // live per-pixel luma
//   Yb   = yb_plane[i]                           // gaussian-blurred luma,
//                                                //   σ = 15px·longEdge/2000,
//                                                //   blurred by 3× box_blur.wgsl
//                                                //   passes encoded by the host
//   edge = |sqrt(max(Y,0)) − sqrt(max(Yb,0))|
//   halo = smoothstep(0.05, 0.25, edge)
//   mult = mix(mult(Yb), mult(Y), halo)          // regional vs per-pixel
//   out  = src[i].rgb · mult                     // uniform scalar → hue-preserving
//
// mult(Y) per mode — VERBATIM from `raw_core::stages::scene_tone_controls`
// (`highlights_mult` / `shadows_mult`; the parity test pins this file to the
// real Rust stage):
//
// * highlights (mode 0): weighted gain exp2(−0.7·h·smoothstep(0.25, 1, Y))
//   engaging below clip, times the sign-branched above-knee shape — h ≥ 0
//   keeps the legacy (1 + (Y−1)/(1+2h)) compression; h < 0 expands by
//   ×(1 + 2|h|), the pole-free mirror (#1081: the legacy shared denominator
//   crossed zero at h = −50 — do NOT collapse the branches back together).
// * shadows (mode 1): mix(1, exp2(1.5·s), (1 − smoothstep(0, 0.25, Y))²) —
//   2.83× / 0.35× cap at the rails (monotonicity-bounded, see S_GAIN_EV in
//   raw-core), exactly 1 at Y ≥ 0.25.
//
// The host encodes the blur of the luma plane OF THE IMAGE STATE ENTERING
// this step (per-step blur — the property that keeps grey-card predictors a
// left-to-right composition), so this kernel only samples the prepared plane.

const LUMA_REC2020: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);

// raw-core scene_tone_controls constants (#1103). Pinned by the parity test.
const S_T1: f32 = 0.25;
const S_GAIN_EV: f32 = 1.5;
const H_W0: f32 = 0.25;
const H_W1: f32 = 1.0;
const H_GAIN_EV: f32 = 0.7;
const SH_MASK_EDGE0: f32 = 0.05;
const SH_MASK_EDGE1: f32 = 0.25;

struct Params {
    count: u32,   // number of RGBA pixels
    mode: u32,    // 0 = highlights, 1 = shadows
    amount: f32,  // slider / 100 (signed)
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> yb_plane: array<f32>;
@group(0) @binding(3) var<storage, read_write> output_buf: array<vec4<f32>>;

fn shadows_mult(y: f32, s_amount: f32) -> f32 {
    let t = 1.0 - smoothstep(0.0, S_T1, y);
    let w = t * t;
    return 1.0 + (exp2(S_GAIN_EV * s_amount) - 1.0) * w;
}

fn highlights_mult(y: f32, h_amount: f32) -> f32 {
    let w = smoothstep(H_W0, H_W1, y);
    let g = exp2(-H_GAIN_EV * h_amount * w);
    var shape = 1.0;
    if (y > 1.0) {
        var y_new: f32;
        if (h_amount >= 0.0) {
            y_new = 1.0 + (y - 1.0) / (1.0 + h_amount * 2.0);
        } else {
            y_new = 1.0 + (y - 1.0) * (1.0 + 2.0 * abs(h_amount));
        }
        shape = y_new / y;
    }
    return shape * g;
}

fn mult_of_y(y: f32) -> f32 {
    if (params.mode == 0u) {
        return highlights_mult(y, params.amount);
    }
    return shadows_mult(y, params.amount);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let y = dot(LUMA_REC2020, px.rgb);
    let ybi = yb_plane[i];
    // sqrt operands clamped at 0 — scene-linear legitimately carries small
    // negatives and sqrt(-x) would poison the mask with NaN.
    let edge = abs(sqrt(max(y, 0.0)) - sqrt(max(ybi, 0.0)));
    let halo = smoothstep(SH_MASK_EDGE0, SH_MASK_EDGE1, edge);
    let m_regional = mult_of_y(ybi);
    let m_local = mult_of_y(y);
    let mult = m_regional + (m_local - m_regional) * halo;
    output_buf[i] = vec4<f32>(px.rgb * mult, px.a);
}
