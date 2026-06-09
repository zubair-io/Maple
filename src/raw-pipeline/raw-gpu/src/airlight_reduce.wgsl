// airlight_reduce.wgsl — threshold scan + masked average for the on-GPU airlight
// reduction (epic #925 P4b / #1033). Stage 2, consuming `airlight_hist.wgsl`'s
// dark-channel histogram.
//
// Replicates `raw_core::stages::dehaze::atmospheric_light` (= `compute_airlight`)
// WITHOUT a sort: A = mean of orig.rgb over the brightest top-0.1% of
// dark-channel positions. The sort is replaced by a percentile threshold:
//
//   1. THRESHOLD SCAN — walk the histogram from the top bin down, accumulating
//      the running pixel count, and stop at the first bin where the count first
//      reaches `top_n = max(count/1000, 1)`. That bin index is the threshold
//      `tau`: every pixel whose dark channel lands in a bin >= tau is "selected."
//      The selected count is the SMALLEST bin-aligned count >= top_n, so it
//      averages `top_n` pixels plus at most the ties in the boundary bin (which
//      all share ~the same dark-channel value → the same bright haze region →
//      a small A delta vs the exact top_n average). This is the documented,
//      deterministic source of the tolerance vs `compute_airlight` (the other
//      source is f32 summation ORDER — see below).
//   2. MASKED AVERAGE — sum orig.rgb over every selected pixel and divide by the
//      selected count. The sum is a workgroup tree-reduction of per-thread f32
//      partials (NO atomics on the float sum — atomics are u32 only under
//      `downlevel_defaults()`, and a fixed-point atomic sum would lose precision
//      and need u64). The only numerical delta from raw-core's sequential sum is
//      float ORDER over the same set of non-negative terms — a ~1e-6 effect.
//
// Run as EXACTLY ONE workgroup (the host dispatches (1,1,1)): the threshold scan
// is inherently global, and a single 256-thread group strided over the image is
// ample for a global mean (this is once per render, not per pixel). `tau` is
// published through a workgroup var after thread 0 scans; the masked sum then
// tree-reduces 256 partials.
//
// 4 storage buffers (hist read + dc read + orig read + airlight read_write) —
// exactly the `downlevel_defaults()` cap. The airlight output is ONE vec4
// (rgb = A, a unused); the host copies it into the dehaze airlight UNIFORM (a
// GPU→GPU copy, no readback) so the transmission + recover kernels read it.

const WG: u32 = 256u;

struct Params {
    count: u32,   // number of pixels (width * height)
    bins: u32,    // histogram bin count (AIRLIGHT_BINS) — must match the hist pass
    top_n: u32,   // max(count / 1000, 1) — the top-0.1% size, computed host-side
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> hist_buf: array<u32>;
@group(0) @binding(2) var<storage, read> dc_buf: array<f32>;
@group(0) @binding(3) var<storage, read> orig_buf: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> airlight_buf: array<vec4<f32>>;

// Workgroup-shared reduction scratch + the published threshold bin.
var<workgroup> tau: u32;
var<workgroup> sum_r: array<f32, WG>;
var<workgroup> sum_g: array<f32, WG>;
var<workgroup> sum_b: array<f32, WG>;
var<workgroup> cnt: array<f32, WG>;

@compute @workgroup_size(WG)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
    let tid = lid.x;
    let n = params.count;
    let bins = params.bins;

    // ── Phase 1: threshold scan (thread 0 only — inherently sequential, cheap). ──
    // Walk bins from the top down, accumulating the running count; stop at the
    // first bin where the cumulative count reaches top_n. That bin is `tau`.
    if (tid == 0u) {
        var acc: u32 = 0u;
        var b: u32 = bins;            // exclusive upper, decremented before use
        var threshold: u32 = 0u;      // default: include everything (count < top_n)
        loop {
            if (b == 0u) { break; }
            b = b - 1u;
            acc = acc + hist_buf[b];
            if (acc >= params.top_n) {
                threshold = b;
                break;
            }
        }
        tau = threshold;
    }
    workgroupBarrier();
    let threshold_bin = tau;

    // ── Phase 2: masked partial sums (each thread strides over the image). ──
    var lr: f32 = 0.0;
    var lg: f32 = 0.0;
    var lb: f32 = 0.0;
    var lc: f32 = 0.0;
    var i: u32 = tid;
    loop {
        if (i >= n) { break; }
        // Bin this pixel's dark channel the SAME way airlight_hist.wgsl does, so
        // "selected" (bin >= tau) is consistent with the scanned counts.
        let dc = clamp(dc_buf[i], 0.0, 1.0);
        var bin = u32(dc * f32(bins));
        if (bin >= bins) { bin = bins - 1u; }
        if (bin >= threshold_bin) {
            let p = orig_buf[i];
            lr = lr + p.r;
            lg = lg + p.g;
            lb = lb + p.b;
            lc = lc + 1.0;
        }
        i = i + WG;
    }
    sum_r[tid] = lr;
    sum_g[tid] = lg;
    sum_b[tid] = lb;
    cnt[tid] = lc;
    workgroupBarrier();

    // ── Phase 3: tree reduction over the 256 partials → slot 0 holds the total. ──
    var stride: u32 = WG / 2u;
    loop {
        if (stride == 0u) { break; }
        if (tid < stride) {
            sum_r[tid] = sum_r[tid] + sum_r[tid + stride];
            sum_g[tid] = sum_g[tid] + sum_g[tid + stride];
            sum_b[tid] = sum_b[tid] + sum_b[tid + stride];
            cnt[tid] = cnt[tid] + cnt[tid + stride];
        }
        workgroupBarrier();
        stride = stride / 2u;
    }

    // Thread 0 writes A = sum / count. count >= 1 in practice (top_n >= 1 selects
    // at least the brightest bin), but guard the divide defensively.
    if (tid == 0u) {
        let k = cnt[0];
        if (k > 0.0) {
            airlight_buf[0] = vec4<f32>(sum_r[0] / k, sum_g[0] / k, sum_b[0] / k, 0.0);
        } else {
            airlight_buf[0] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
    }
}
