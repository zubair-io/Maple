// DehazeDarkChannel.metal — first pass of the dehaze chain. Mirrors
// `dark_channel` at src/raw-pipeline/raw-core/src/stages/dehaze.rs:5-25.
//
// Per output pixel: read the 15x15 RGB neighborhood (radius DARK_RADIUS=7,
// clamp-to-edge), compute min(r,g,b) per neighbor, take the min across the
// kernel, write to a single-channel R16Float texture.
//
// Compile path: pure Metal compute (no `coreimage::` types, no
// `[[stitchable]]`). Loaded via `MTLDevice.makeLibrary(source:options:)`
// like SeparableGaussianBlur.metal.
//
// Performance note: 225 reads per output is bounded but uncached. A
// threadgroup-shared tile-load with a 16+14 = 30-pixel-per-axis halo
// would amortize reads across threads — deferred to Plan 2 v2 v6 if
// profiling shows this kernel dominates the 16 ms slider budget.

#include <metal_stdlib>
using namespace metal;

constant int DARK_RADIUS = 7;

kernel void dehazeDarkChannel(
    texture2d<half, access::read>   src   [[texture(0)]],
    texture2d<half, access::write>  dst   [[texture(1)]],
    uint2 gid                              [[thread_position_in_grid]]
) {
    const int w = int(src.get_width());
    const int h = int(src.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float m = INFINITY;
    for (int dy = -DARK_RADIUS; dy <= DARK_RADIUS; ++dy) {
        for (int dx = -DARK_RADIUS; dx <= DARK_RADIUS; ++dx) {
            int ux = clamp(int(gid.x) + dx, 0, w - 1);
            int uy = clamp(int(gid.y) + dy, 0, h - 1);
            float4 p = float4(src.read(uint2(uint(ux), uint(uy))));
            float local_min = min(p.r, min(p.g, p.b));
            if (local_min < m) m = local_min;
        }
    }
    dst.write(half4(half(m), 0, 0, 0), gid);
}
