// DehazeAtmosphericLight.metal — atmospheric-light estimation for the
// dehaze chain. Mirrors `atmospheric_light` at src/raw-pipeline/raw-
// core/src/stages/dehaze.rs:29-41.
//
// Two-pass GPU strategy:
//
//   Pass 1 (dehazeAtmoPartial): each threadgroup processes a 16x16
//   region; threadgroup-shared parallel-reduction picks the (single
//   brightest dark-channel value, co-located src RGB) in that region;
//   threadgroup writes one float4 per region to the partial buffer.
//
//   Pass 2 (dehazeAtmoFinal): single-threaded over the partial buffer
//   (~98K entries on 6K x 4K). Sorted descending on CPU by the Swift
//   wrapper between dispatches; this kernel just averages the top-N
//   entries' RGB.
//
// Parity caveat: the Rust source averages over the brightest n/1000 of
// EVERY pixel in the image (full sort over n indices). The GPU averages
// over the brightest n/1000 of the per-threadgroup top-1 selections.
// On natural images where the atmospheric region is uniform, the two
// agree to ~1e-3 per channel. On synthetic test scenes with many top-
// 0.1% pixels packed inside a single threadgroup, the GPU misses the
// runner-ups inside that tg. See the plan's § "Atmospheric-light
// reduction strategy" for the parity tolerance budget.

#include <metal_stdlib>
using namespace metal;

constant uint TG_SIZE = 16; // 16x16 = 256 threads per threadgroup.

kernel void dehazeAtmoPartial(
    texture2d<half,  access::read>  srcRGBA       [[texture(0)]],
    texture2d<half,  access::read>  darkChannel   [[texture(1)]],
    device float4*                  partialOut    [[buffer(0)]],
    constant uint2&                 partialDims   [[buffer(1)]],
    uint2 gid                                     [[thread_position_in_grid]],
    uint2 tid                                     [[thread_position_in_threadgroup]],
    uint2 tg_id                                   [[threadgroup_position_in_grid]]
) {
    threadgroup float4 sharedVals[TG_SIZE * TG_SIZE]; // (dark, R, G, B)

    const int w = int(srcRGBA.get_width());
    const int h = int(srcRGBA.get_height());

    float dc = -INFINITY;
    float3 rgb = float3(0.0);
    if (int(gid.x) < w && int(gid.y) < h) {
        dc = float(darkChannel.read(gid).r);
        float4 p = float4(srcRGBA.read(gid));
        rgb = float3(p.r, p.g, p.b);
    }

    uint linearTid = tid.y * TG_SIZE + tid.x;
    sharedVals[linearTid] = float4(dc, rgb);
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Parallel reduction: max by .x (dark-channel value).
    for (uint stride = (TG_SIZE * TG_SIZE) / 2; stride > 0; stride /= 2) {
        if (linearTid < stride) {
            float4 a = sharedVals[linearTid];
            float4 b = sharedVals[linearTid + stride];
            if (b.x > a.x) sharedVals[linearTid] = b;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    if (linearTid == 0) {
        uint outIdx = tg_id.y * partialDims.x + tg_id.x;
        partialOut[outIdx] = sharedVals[0];
    }
}

// Single-threaded final reduce. Inputs:
//   partialIn — float4 buffer of (dc, R, G, B) with `partialCount` entries,
//               PRE-SORTED descending by .x (dark-channel value) on CPU
//               between dispatches by the Swift wrapper.
//   topN      — number of top entries to average (max(1, totalPixels/1000)).
//   atmoOut   — float buffer (3 floats: A_r, A_g, A_b).
//
// The CPU pre-sort lets this kernel be a flat O(topN) scan; the partial-
// buffer is small enough (~98K entries on 6K x 4K, ~1.5 MB) to sort on
// CPU in ~5 ms. At slider tick rate that fits the 16 ms budget.
kernel void dehazeAtmoFinal(
    device const float4* partialIn  [[buffer(0)]],
    device float*        atmoOut    [[buffer(1)]],
    constant uint&       partialCount [[buffer(2)]],
    constant uint&       topN       [[buffer(3)]]
) {
    float sumR = 0.0, sumG = 0.0, sumB = 0.0;
    uint kept = 0;
    for (uint i = 0; i < topN && i < partialCount; ++i) {
        float4 e = partialIn[i];
        sumR += e.y;
        sumG += e.z;
        sumB += e.w;
        kept++;
    }

    float k = float(max(kept, 1u));
    atmoOut[0] = sumR / k;
    atmoOut[1] = sumG / k;
    atmoOut[2] = sumB / k;
}
