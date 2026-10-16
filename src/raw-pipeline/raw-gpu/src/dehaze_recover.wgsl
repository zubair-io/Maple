// dehaze_recover.wgsl — dehaze's final per-pixel scene recovery (epic #925 P2
// wave 3b / #990). The MULTI-INPUT tail: it reads the original image plus two
// derived planes (the guided-filter coefficients and the sky mask) and writes
// the recovered image — exactly 4 storage buffers, the `downlevel_defaults()`
// cap (orig + ab + sky + out).
//
// `t_refined` is REconstructed here from the packed guided coefficients
// ab = (mean_a, mean_b) and the recomputed luma:
//   t_refined = mean_a * luma + mean_b
// (the guided filter's final reconstruction `mean_a * guide + mean_b`, guide ==
// luma). Recomputing luma from orig.rgb with the SAME weighted sum the products
// kernel used keeps it bit-identical and avoids a 5th storage binding.
//
// PARITY-CRITICAL — mirrors `raw_core::stages::dehaze::recover_with_mask`,
// operation order verbatim:
//   t      = clamp(t_refined, 0, 1)
//   scale  = clamp(dehaze / 100, -1, 1)
//   scale >= 0:
//     supported_t = max(t, clamp(1 - omega * min(I / max(A, A_floor)), 0, 1))
//     t_eff = max(supported_t + (1-supported_t)*(1-scale), t0)
//     J     = (I - A) / t_eff + A
//   scale < 0:
//     t_haze = 1 - (-scale)*(1-t)
//     J      = I*t_haze + A*(1-t_haze)    (forward atmospheric model, #2187)
//   m      = clamp(mask, 0, 1)
//   out    = (1 - m) * J + m * I
// t0 = 0.1 (transmission floor), guarding the divide on the darkest patches.

const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;
const T0: f32 = 0.1;   // transmission floor — raw-core's t0.

// AIRLIGHT (epic #925 P4b / #1033): A rides a SECOND uniform binding (binding 5),
// NOT the `Params` struct. Recovery already binds 4 storage buffers (orig + ab +
// sky + out) — the `downlevel_defaults()` cap — so A could not become a 5th
// storage binding; a uniform doesn't count against the storage cap (the uniform
// cap is 12). The same binding serves whether A was computed CPU-side (written via
// `queue.write_buffer`) or on-GPU (copied GPU→GPU from the airlight-reduce output
// — no readback).
struct Params {
    count: u32,
    scale: f32,   // clamp(dehaze / 100, -1, 1), precomputed CPU-side.
    _pad0: u32,
    _pad1: u32,
};

// Atmospheric light A (RAW, unclamped — the recovery value). vec4 for alignment;
// .a unused.
struct Airlight {
    value: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> orig_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> ab_buf: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> sky_buf: array<f32>;
@group(0) @binding(4) var<storage, read_write> output_buf: array<vec4<f32>>;
@group(0) @binding(5) var<uniform> airlight: Airlight;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = orig_buf[i];
    let luma = LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b;
    let ab = ab_buf[i];               // (mean_a, mean_b)
    let t_refined = ab.x * luma + ab.y;

    let t = clamp(t_refined, 0.0, 1.0);
    let scale = params.scale;
    let a = airlight.value.rgb;       // RAW A.
    var j: vec3<f32>;
    if (scale >= 0.0) {
        // Retain the original estimate's haze fraction after guided refinement.
        // This constrains transmission, never the signed/HDR scene pixels.
        let ratio = p.rgb / max(a, vec3<f32>(DEHAZE_AIRLIGHT_FLOOR));
        let point_min = min(min(ratio.r, ratio.g), ratio.b);
        let point_transmission = clamp(1.0 - DEHAZE_TRANSMISSION_OMEGA * point_min, 0.0, 1.0);
        let supported_t = max(t, point_transmission);
        if (supported_t == 1.0) {
            output_buf[i] = p;
            return;
        }
        let t_eff = max(supported_t + (1.0 - supported_t) * (1.0 - scale), T0);
        j = (p.rgb - a) / t_eff + a;
    } else {
        let t_haze = 1.0 - (-scale) * (1.0 - t);
        j = p.rgb * t_haze + a * (1.0 - t_haze);
    }

    let m = clamp(sky_buf[i], 0.0, 1.0);
    let inv_m = 1.0 - m;
    let out = inv_m * j + m * p.rgb;
    output_buf[i] = vec4<f32>(out, p.a);
}
