// scope_vectorscope.wgsl — mask-weighted Rec.709 Cb/Cr histogram of the
// display-encoded chain buffer (#3272, spec §5.4). Twin of
// raw_core::scope::vectorscope_histogram_rgba. Integer atomics ⇒ deterministic
// regardless of dispatch order.
//
// Bin `bins*bins` (one past the 128×128 grid) accumulates the total weight —
// the same trailing-total layout `raw_core::scope::unpack_scope` (Rust) and
// `SCOPE_HIST_BYTE_LEN` (this crate's `scope.rs`) both assume.

struct Params {
    count: u32,      // number of RGBA pixels in `src`
    bins: u32,       // VECTORSCOPE_BINS (128) — grid side length
    use_alpha: u32,  // 0 = weight every pixel 1; nonzero = weight by src[i].a
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> hist: array<atomic<u32>>;

// raw_core::scope::WEIGHT_SCALE — 1/255 fixed point, so a feathered mask edge
// contributes fractionally to an otherwise-integer histogram.
const WEIGHT_SCALE: f32 = 255.0;

// raw_core::scope::bin_index's single-axis half: maps [-0.5, 0.5) onto
// 0..bins and clamps outside it.
fn axis_bin(v: f32, bins: u32) -> u32 {
    let scaled = max((v + 0.5) * f32(bins), 0.0);
    return min(u32(scaled), bins - 1u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let p = src[i];
    let wf = select(1.0, clamp(p.a, 0.0, 1.0), params.use_alpha != 0u);
    let w = u32(round(wf * WEIGHT_SCALE));
    if (w == 0u) {
        return;
    }
    // raw_core::scope::cb_cr_rec709.
    let cb = -0.114572 * p.r - 0.385428 * p.g + 0.5 * p.b;
    let cr = 0.5 * p.r - 0.454153 * p.g - 0.045847 * p.b;
    let idx = axis_bin(cr, params.bins) * params.bins + axis_bin(cb, params.bins);
    atomicAdd(&hist[idx], w);
    atomicAdd(&hist[params.bins * params.bins], w);
}
