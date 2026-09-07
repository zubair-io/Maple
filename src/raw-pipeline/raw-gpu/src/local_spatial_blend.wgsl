// local_spatial_blend.wgsl — the mask-weighted lerp that confines one
// layer's SPATIAL control group to its mask (#3407).
//
// Ports the tail of `raw_core::stages::local_adjustments::spatial::blend`:
//
//     out = base + w * (filtered - base)
//
// written in exactly that term order rather than as WGSL's `mix`, which
// evaluates `base * (1 - w) + filtered * w` — a different float sequence, so
// it would drift from the Rust stage under the parity gate.
//
// Three inputs because the pass has to reconstruct two things the chain
// buffer alone cannot carry:
//
//  * `base` is the layer's output after its POINT controls, and its ALPHA is
//    the layer's per-pixel mask weight — written there by the same
//    `local_adjustments.wgsl` scope-target path the vectorscope uses, so
//    there is no second WGSL implementation of the mask evaluator.
//  * `filtered` is `base` after the engaged spatial kernels ran over the
//    whole buffer.
//  * `original` is the buffer the chain handed the stage, read ONLY for its
//    alpha: `base`'s alpha was overwritten with the weight, and unless this
//    layer is the vectorscope's scope target that alpha has to come back.

struct Params {
    count: u32,
    /// 1 when this layer is the chain's scope target, so the mask weight is
    /// what alpha should carry downstream (#3272); 0 to restore `original`'s.
    keep_weight_in_alpha: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> original: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> base: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> filtered: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let b = base[i];
    let w = b.a;
    let alpha = select(original[i].a, w, params.keep_weight_in_alpha != 0u);
    // Pixels the mask does not reach pass through bit-identical rather than
    // round-tripping a lerp that returns them unchanged only up to noise —
    // the same `if w <= 0.0 { return; }` guard the Rust blend uses.
    if (w <= 0.0) {
        output_buf[i] = vec4<f32>(b.rgb, alpha);
        return;
    }
    let f = filtered[i].rgb;
    output_buf[i] = vec4<f32>(b.rgb + w * (f - b.rgb), alpha);
}
