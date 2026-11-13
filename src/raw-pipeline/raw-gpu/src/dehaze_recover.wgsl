// dehaze_recover.wgsl — dehaze's final per-pixel scene recovery (epic #925 P2
// wave 3b / #990), reading the haze map measured at the fixed proxy
// resolution (#3287). The MULTI-INPUT tail: the full-resolution image plus the
// two proxy planes (guided-filter coefficients and sky mask) → the recovered
// image — exactly 4 storage buffers, the `downlevel_defaults()` cap
// (orig + ab + sky + out).
//
// The proxy planes are sampled bilinearly at the rendered pixel's place in
// the frame, `u = max((x + 0.5) * pw / W - 0.5, 0)` per axis with clamped
// taps — the same f32 expression as raw-core's `axis_taps` — and the refined
// transmission is rebuilt from the RENDERED pixel's luma:
//   t_refined = mean_a * (luma - luma(A)) + mean_b
// (He & Sun's fast guided filter), so edges stay at render resolution.
//
// PARITY-CRITICAL — mirrors `raw_core::stages::dehaze::recover_pixel`,
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
// NOT the `Params` struct, so it is not a 5th storage binding.
struct Params {
    width: u32,
    height: u32,
    scale: f32,   // clamp(dehaze / 100, -1, 1), precomputed CPU-side.
    _pad0: u32,
    proxy_width: u32,
    proxy_height: u32,
    _pad1: u32,
    _pad2: u32,
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

struct Taps {
    i0: u32,
    i1: u32,
    w: f32,
};

fn axis_taps(index: u32, frame: u32, proxy: u32) -> Taps {
    let u = max((f32(index) + 0.5) * (f32(proxy) / f32(frame)) - 0.5, 0.0);
    let last = proxy - 1u;
    let i0 = min(u32(floor(u)), last);
    let i1 = min(i0 + 1u, last);
    return Taps(i0, i1, clamp(u - f32(i0), 0.0, 1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.width * params.height) {
        return;
    }
    let p = orig_buf[i];
    let pw = params.proxy_width;
    let tx = axis_taps(i % params.width, params.width, pw);
    let ty = axis_taps(i / params.width, params.height, params.proxy_height);
    let r0 = ty.i0 * pw;
    let r1 = ty.i1 * pw;
    let ab_top = ab_buf[r0 + tx.i0] + tx.w * (ab_buf[r0 + tx.i1] - ab_buf[r0 + tx.i0]);
    let ab_bottom = ab_buf[r1 + tx.i0] + tx.w * (ab_buf[r1 + tx.i1] - ab_buf[r1 + tx.i0]);
    let ab = ab_top + ty.w * (ab_bottom - ab_top);   // (mean_a, mean_b)
    let sky_top = sky_buf[r0 + tx.i0] + tx.w * (sky_buf[r0 + tx.i1] - sky_buf[r0 + tx.i0]);
    let sky_bottom = sky_buf[r1 + tx.i0] + tx.w * (sky_buf[r1 + tx.i1] - sky_buf[r1 + tx.i0]);
    let sky = sky_top + ty.w * (sky_bottom - sky_top);

    let a = airlight.value.rgb;       // RAW A.
    // The guide is luma measured from luma(A), as the map was built (#3287).
    let guide = (LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b) - (LUMA_R * a.r + LUMA_G * a.g + LUMA_B * a.b);
    let t_refined = ab.x * guide + ab.y;

    let t = clamp(t_refined, 0.0, 1.0);
    let scale = params.scale;
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

    let m = clamp(sky, 0.0, 1.0);
    let inv_m = 1.0 - m;
    let out = inv_m * j + m * p.rgb;
    output_buf[i] = vec4<f32>(out, p.a);
}
