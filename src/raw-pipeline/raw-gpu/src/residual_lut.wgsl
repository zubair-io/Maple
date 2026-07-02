// residual_lut.wgsl — Auto Profile per-image residual 3D LUT (#924), a P2
// view-transform stage (epic #925 / #990).
//
// Line-for-line WGSL port of `raw_core::view::auto_profile::lut::ColorLut::sample`
// (the trilinear apply layered onto the Auto Profile cube). The LUT is PER-IMAGE
// RUNTIME DATA (fitted from the embedded JPEG, NOT a codegen constant), so the
// flat grid rides a read-only storage buffer uploaded per pass — the canonical
// "runtime 3D LUT in storage + trilinear sample" shape the spatial / P3 / P4
// waves reuse.
//
// PARITY-CRITICAL invariants (mirrored verbatim from lut.rs `sample` / `node`):
//   * Grid layout: index = ((b*N + g)*N + r)*3 + c. `size` (N) is a runtime
//     uniform; last = f32(N - 1).
//   * Per-channel: p = clamp(rgb[c], 0, 1) * last; lo = min(floor(p), last - 1);
//     f = p - lo. The `min(_, last - 1)` is load-bearing: an input of exactly
//     1.0 lands in the TOP cell with f = 1.0 (not an out-of-range node read).
//   * Trilinear nesting order r (f0) -> g (f1) -> b (f2), per output channel,
//     for bit-stable accumulation matching the Rust `sample`.
//   * RGB lanes only; alpha carried through.

struct Params {
    count: u32,   // number of RGBA pixels
    size: u32,    // LUT nodes per axis (N); grid is N*N*N*3 floats
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;
// The fitted residual grid (N*N*N*3 f32, layout ((b*N+g)*N+r)*3+c). Read-only
// storage (4-byte stride) — a uniform array<f32> would get a 16-byte per-element
// stride and silently misalign. Per-image runtime data, uploaded each pass.
@group(0) @binding(3) var<storage, read> lut: array<f32>;

// One grid node's RGB triplet. Mirrors `ColorLut::node`: manual flat index in
// u32, NO bounds clamp (the caller's `lo + 1` never exceeds N-1 because lo is
// capped at last-1).
fn lut_node(r: u32, g: u32, b: u32, n: u32) -> vec3<f32> {
    let i = ((b * n + g) * n + r) * 3u;
    return vec3<f32>(lut[i], lut[i + 1u], lut[i + 2u]);
}

// Trilinear lookup of one RGB triplet (inputs clamped to [0, 1]). Mirrors
// `ColorLut::sample` EXACTLY — same lo/f derivation (with the `min(_, last-1)`
// top-cell guard) and the same r->g->b corner-blend nesting per channel.
fn lut_sample(rgb: vec3<f32>, n: u32) -> vec3<f32> {
    let last = f32(n - 1u);

    let p_r = clamp(rgb[0], 0.0, 1.0) * last;
    let l_r = min(floor(p_r), last - 1.0);
    let r0 = u32(l_r);
    let f_r = p_r - l_r;

    let p_g = clamp(rgb[1], 0.0, 1.0) * last;
    let l_g = min(floor(p_g), last - 1.0);
    let g0 = u32(l_g);
    let f_g = p_g - l_g;

    let p_b = clamp(rgb[2], 0.0, 1.0) * last;
    let l_b = min(floor(p_b), last - 1.0);
    let b0 = u32(l_b);
    let f_b = p_b - l_b;

    let r1 = r0 + 1u;
    let g1 = g0 + 1u;
    let b1 = b0 + 1u;

    var out = vec3<f32>(0.0, 0.0, 0.0);
    for (var c: i32 = 0; c < 3; c = c + 1) {
        let c000 = lut_node(r0, g0, b0, n)[c];
        let c100 = lut_node(r1, g0, b0, n)[c];
        let c010 = lut_node(r0, g1, b0, n)[c];
        let c110 = lut_node(r1, g1, b0, n)[c];
        let c001 = lut_node(r0, g0, b1, n)[c];
        let c101 = lut_node(r1, g0, b1, n)[c];
        let c011 = lut_node(r0, g1, b1, n)[c];
        let c111 = lut_node(r1, g1, b1, n)[c];
        let c00 = c000 * (1.0 - f_r) + c100 * f_r;
        let c10 = c010 * (1.0 - f_r) + c110 * f_r;
        let c01 = c001 * (1.0 - f_r) + c101 * f_r;
        let c11 = c011 * (1.0 - f_r) + c111 * f_r;
        let c0 = c00 * (1.0 - f_g) + c10 * f_g;
        let c1 = c01 * (1.0 - f_g) + c11 * f_g;
        out[c] = c0 * (1.0 - f_b) + c1 * f_b;
    }
    return out;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let out = lut_sample(px.rgb, params.size);
    output_buf[i] = vec4<f32>(out, px.a);
}
