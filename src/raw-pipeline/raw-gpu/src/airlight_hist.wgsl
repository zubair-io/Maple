// airlight_hist.wgsl — dark-channel histogram for the on-GPU airlight reduction
// (epic #925 P4b / #1033, the C5b reduction that removes the per-tick GPU→CPU
// airlight readback C5a took).
//
// raw-core's atmospheric light A is the mean of the ORIGINAL rgb at the brightest
// top-0.1% of dark-channel positions (`raw_core::stages::dehaze::atmospheric_light`
// = `compute_airlight`): sort the dark channel descending, take `top_n =
// max(n/1000, 1)`, average orig.rgb there. A SORT can't be matched bit-for-bit on
// the GPU (tie-break order is undefined across threads), so #1033 selects the
// top-0.1% by a PERCENTILE THRESHOLD instead: histogram the dark channel, scan
// from the top bin until the running count first reaches `top_n` (the reduce
// kernel does the scan + the masked average), then average orig.rgb over every
// pixel whose dark channel lands in a bin at or above that threshold. The result
// matches `compute_airlight` to a documented tolerance (NOT bit-exact) — see
// `airlight/tests.rs`.
//
// THIS kernel is stage 1: an atomic histogram of the dark channel `dc` into
// `BINS` bins.
//
// BINNING SPACE — the dark channel is min(r,g,b) of the SCENE-LINEAR image, which
// is UNBOUNDED above (HDR headroom: a window min over a > 1.0 region is itself
// > 1.0). Binning over a fixed [0, 1] would collapse the entire bright tail into
// the top bin, so the threshold scan would average far MORE than `top_n` pixels
// with wildly different colours — exactly the brightest pixels the airlight cares
// about. Instead we bin over the MONOTONIC tonemap `t = dc / (1 + dc)` ∈ [0, 1):
// it is strictly increasing in `dc` (dc >= 0), so the percentile ordering — and
// thus the top-0.1% selection — is IDENTICAL to binning raw `dc`, but the bright
// tail (incl. dc > 1) spreads across distinct high bins instead of piling into
// one. Negative dc (a clamp artefact) maps to bin 0. The reduce kernel uses the
// SAME transform so "selected" is consistent. Integer atomic adds commute, so the
// histogram is order-independent / deterministic across threads (unlike the float
// sort it replaces).
//
// 2 storage buffers (dc read + histogram atomic read_write) — well within the
// `downlevel_defaults()` 4-storage cap. The bin count rides the uniform so the
// host owns it (single-sourced with the reduce kernel via `AIRLIGHT_BINS`).

struct Params {
    count: u32,   // number of pixels (width * height)
    bins: u32,    // histogram bin count (AIRLIGHT_BINS)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> dc_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> hist_buf: array<atomic<u32>>;

// Map a dark-channel value to its histogram bin via the monotonic tonemap
// `t = dc / (1 + dc)` (dc >= 0 → t ∈ [0, 1)). MUST be identical to the reduce
// kernel's copy so the scanned counts and the masked-average selection agree.
fn dc_to_bin(dc: f32, bins: u32) -> u32 {
    let t = max(dc, 0.0) / (1.0 + max(dc, 0.0));   // negative dc → 0
    var bin = u32(t * f32(bins));
    if (bin >= bins) {
        bin = bins - 1u;   // guard the t→1 limit (only as dc→∞).
    }
    return bin;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let bin = dc_to_bin(dc_buf[i], params.bins);
    atomicAdd(&hist_buf[bin], 1u);
}
