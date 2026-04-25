// DehazeTransmission.metal — transmission-map estimation for the dehaze
// chain. Mirrors `transmission` at src/raw-pipeline/raw-core/src/
// stages/dehaze.rs:43-68.
//
// Per output pixel: read the 15x15 RGB neighborhood (radius 7, clamp-
// to-edge), compute min(r/A_r, g/A_g, b/A_b) per neighbor, take the
// min across the kernel, write `1 - 0.95 * kernel_min` to a single-
// channel R16Float texture.

#include <metal_stdlib>
using namespace metal;

constant int TRANS_RADIUS = 7;
constant float OMEGA = 0.95;

kernel void dehazeTransmission(
    texture2d<half, access::read>   src        [[texture(0)]],
    texture2d<half, access::write>  dst        [[texture(1)]],
    device const float*             atmoBuf    [[buffer(0)]],   // [A_r, A_g, A_b]
    uint2 gid                                   [[thread_position_in_grid]]
) {
    const int w = int(src.get_width());
    const int h = int(src.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float A_r = max(atmoBuf[0], 1e-6);
    float A_g = max(atmoBuf[1], 1e-6);
    float A_b = max(atmoBuf[2], 1e-6);

    float m = INFINITY;
    for (int dy = -TRANS_RADIUS; dy <= TRANS_RADIUS; ++dy) {
        for (int dx = -TRANS_RADIUS; dx <= TRANS_RADIUS; ++dx) {
            int ux = clamp(int(gid.x) + dx, 0, w - 1);
            int uy = clamp(int(gid.y) + dy, 0, h - 1);
            float4 p = float4(src.read(uint2(uint(ux), uint(uy))));
            float scaledMin = min(min(p.r / A_r, p.g / A_g), p.b / A_b);
            if (scaledMin < m) m = scaledMin;
        }
    }
    float t = 1.0 - OMEGA * m;
    dst.write(half4(half(t), 0, 0, 0), gid);
}
