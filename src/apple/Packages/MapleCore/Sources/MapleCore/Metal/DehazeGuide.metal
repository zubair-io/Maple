// DehazeGuide.metal — luma-guide construction for the guided filter.
// Mirrors the inline guide construction at raw-core/src/stages/dehaze.
// rs:156-158: guide[i] = 0.2627*r + 0.6780*g + 0.0593*b (Rec.2020 luma).

#include <metal_stdlib>
using namespace metal;

kernel void dehazeBuildGuide(
    texture2d<half, access::read>   src   [[texture(0)]],
    texture2d<half, access::write>  dst   [[texture(1)]],
    uint2 gid                              [[thread_position_in_grid]]
) {
    const int w = int(src.get_width());
    const int h = int(src.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float4 p = float4(src.read(gid));
    float y = 0.2627 * p.r + 0.6780 * p.g + 0.0593 * p.b;
    dst.write(half4(half(y), 0, 0, 0), gid);
}
