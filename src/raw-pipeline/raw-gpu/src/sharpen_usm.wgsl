// sharpen_usm.wgsl — luminance-only unsharp-mask SCALE step (epic #925 P3 wave 2
// / #991). The per-pixel core of `raw_core::stages::sharpen::apply`: build the
// "full-strength sharpened" buffer (amount=100, masking=0) that the edge-mix step
// (sharpen_mix.wgsl) later blends with the observed image by the
// amount / detail / masking sliders.
//
// PARITY-CRITICAL — mirrors the per-pixel USM loop of
// `raw_core::stages::sharpen::apply` byte-for-byte:
//   lo     = li + (li - lb)                     (li = luma, lb = blur(luma))
//   weight = smoothstep(EPS, BAND*EPS, li)      (shadow guard)
//   scale  = 1 + weight * (clamp(lo / max(li, EPS), MIN, MAX) - 1)
//   out    = observed.rgb * scale               (alpha carried through)
// Luma-only: every RGB channel scales by the SAME scalar, so chroma ratios are
// preserved by construction (the #439 no-fringing contract). Operation order kept
// verbatim so the result bit-matches raw-core (only float order differs, ~1e-6).
//
// 4 storage: src(RGBA) + luma + luma_blur + sharpened(RGBA). The `luma` plane is
// the SAME plane the blur was computed from (sharpen_luma.wgsl wrote it), passed
// in rather than recomputed so `li` here is bit-identical to the value `lb` was
// blurred from.

// Constants — must stay in lockstep with `raw_core::stages::sharpen`.
const SHADOW_EPSILON: f32 = 1e-4;
const SHADOW_BAND: f32 = 4.0;
const MAX_SCALE: f32 = 4.0;
const MIN_SCALE: f32 = 0.0;

struct Params {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> luma_buf: array<f32>;
@group(0) @binding(3) var<storage, read> luma_blur_buf: array<f32>;
@group(0) @binding(4) var<storage, read_write> sharpened_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let o = src_buf[i];
    let li = luma_buf[i];
    let lb = luma_blur_buf[i];
    let lo = li + (li - lb);

    // smoothstep(EPS, BAND*EPS, li) — WGSL's built-in is the identical
    // clamp-then-Hermite formula raw-core's `smoothstep` uses.
    let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, li);
    let safe_luma = max(li, SHADOW_EPSILON);
    let raw_scale = lo / safe_luma;
    let bounded = clamp(raw_scale, MIN_SCALE, MAX_SCALE);
    let scale = 1.0 + weight * (bounded - 1.0);

    sharpened_buf[i] = vec4<f32>(o.rgb * scale, o.a);
}
