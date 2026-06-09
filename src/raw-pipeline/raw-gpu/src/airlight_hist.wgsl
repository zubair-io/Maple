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
// `BINS` uniform bins over [0, 1]. The dark channel is min(r,g,b) of the
// scene-linear image; values < 0 clamp to bin 0 and values >= 1 clamp to the top
// bin (HDR-headroom dark-channel values are the brightest, so the top bin is
// where the airlight selection lives anyway — clamping there is correct, not a
// loss). Integer atomic adds commute, so the histogram is order-independent /
// deterministic across threads (unlike the float sort it replaces).
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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }
    let bins = params.bins;
    // Bin index: floor(dc * bins) clamped to [0, bins-1]. clamp(dc, 0, 1) first so
    // negative / >1 dark-channel values land in the end bins rather than indexing
    // out of range.
    let dc = clamp(dc_buf[i], 0.0, 1.0);
    var bin = u32(dc * f32(bins));
    if (bin >= bins) {
        bin = bins - 1u;   // dc == 1.0 maps to `bins`, fold into the top bin.
    }
    atomicAdd(&hist_buf[bin], 1u);
}
