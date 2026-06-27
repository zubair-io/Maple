// guided_combine.wgsl — the clarity/texture base/detail recombine (epic #925
// P2 wave 3b / #990). Shared by clarity / texture (only the upstream blur radius
// differs between the two stages; this combine is identical).
//
// Inputs (all width*height):
//   orig    — the source RGBA image (RGB scaled, alpha carried through). `luma`
//             is RECOMPUTED from orig.rgb here rather than read from a 5th storage
//             buffer — see the binding-budget note below.
//   mean_a  — blur(a)
//   mean_b  — blur(b)
// Output:
//   out RGBA — orig.rgb * scale, alpha untouched
//
// BINDING BUDGET — `downlevel_defaults()` (the WebGPU baseline the Apple/web
// targets share) caps `max_storage_buffers_per_shader_stage` at 4. A combine that
// also read a separate `luma` plane would need 5 storage buffers (orig + luma +
// mean_a + mean_b + out) and fail to derive a layout. So `luma` is recomputed
// from `orig.rgb` with the SAME weighted sum (same order) `guided_luma.wgsl`
// used — bit-identical to the luma plane — keeping the kernel at 4 storage
// buffers. This is the constraint the reusable spatial pattern lives within
// (dehaze / P3 multi-input combines must also fit 4).
//
// PARITY-CRITICAL — mirrors the per-pixel tail of
// `raw_core::stages::{clarity,texture}::apply`:
//   luma   = LUMA_REC2020 . orig.rgb       (recomputed; == the guided_luma plane)
//   if luma <= LUMA_FLOOR: identity        (#1088 — below the floor the
//                                           quotient stops being a ratio;
//                                           near-black beside bright content
//                                           exploded to scale ≈ -3e5)
//   base   = mean_a * luma + mean_b        (guided_filter's final reconstruction)
//   detail = luma - base
//   boost  = luma + detail * amount        (amount = clarity / 100)
//   scale  = boost / luma
//   out    = orig.rgb * scale
// Operation order kept verbatim so the result bit-matches raw-core.

const LUMA_FLOOR: f32 = 1e-6;
// Rec.2020 luma weights — identical to guided_luma.wgsl so the recomputed luma
// here is bit-for-bit the same value the luma plane held.
const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

struct Params {
    count: u32,    // number of RGBA pixels (== plane samples)
    amount: f32,   // clarity / 100 (or texture / 100)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> orig_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> mean_a_buf: array<f32>;
@group(0) @binding(3) var<storage, read> mean_b_buf: array<f32>;
@group(0) @binding(4) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = orig_buf[i];
    // Recompute luma from orig.rgb (same order as guided_luma.wgsl → bit-identical).
    let luma = LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b;
    // Identity at/below the luma floor (#1088) — mirrors raw-core's guard.
    if (luma <= LUMA_FLOOR) {
        output_buf[i] = p;
        return;
    }
    let base = mean_a_buf[i] * luma + mean_b_buf[i];
    let detail = luma - base;
    let boost = luma + detail * params.amount;
    let scale = boost / luma;
    output_buf[i] = vec4<f32>(p.rgb * scale, p.a);
}
