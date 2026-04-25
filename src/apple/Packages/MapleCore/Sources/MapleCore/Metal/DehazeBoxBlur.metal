// DehazeBoxBlur.metal — single-pass running-sum box blur with truncated-
// window normalization on a single-channel R16Float texture. Mirrors the
// dehaze-local `box_blur` at raw-core/src/stages/dehaze.rs:72-105 byte-
// for-byte.
//
// IMPORTANT: this is NOT the same as SeparableGaussianBlur from Plan 2
// v2 v1. SeparableGaussianBlur runs 3 passes at radius/3 to approximate
// a Gaussian. The dehaze guided filter expects a single-pass running-
// sum with `out = acc / count` where `count` shrinks at the boundaries
// (truncated-window). Reusing SeparableGaussianBlur here would produce
// visibly different t_refined values, breaking parity with Rust.
//
// Two kernel functions: dehazeBoxBlurH (horizontal) and dehazeBoxBlurV
// (vertical). The Swift wrapper allocates ping-pong R16Float scratches
// and calls dehazeBoxBlurH then dehazeBoxBlurV (just one of each, no
// triple-pass).

#include <metal_stdlib>
using namespace metal;

// Horizontal box blur: each output pixel reads [max(0, x-r), min(w-1,
// x+r)] inclusive on the same row; averages over the visible window.
kernel void dehazeBoxBlurH(
    texture2d<half, access::read>   src   [[texture(0)]],
    texture2d<half, access::write>  dst   [[texture(1)]],
    constant uint& radius                  [[buffer(0)]],
    uint2 gid                              [[thread_position_in_grid]]
) {
    const int w = int(src.get_width());
    const int h = int(src.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    int x0 = max(0, int(gid.x) - int(radius));
    int x1 = min(w - 1, int(gid.x) + int(radius));

    float acc = 0.0;
    int count = 0;
    for (int x = x0; x <= x1; ++x) {
        acc += float(src.read(uint2(uint(x), gid.y)).r);
        ++count;
    }
    half v = half(acc / float(count));
    dst.write(half4(v, 0, 0, 0), gid);
}

kernel void dehazeBoxBlurV(
    texture2d<half, access::read>   src   [[texture(0)]],
    texture2d<half, access::write>  dst   [[texture(1)]],
    constant uint& radius                  [[buffer(0)]],
    uint2 gid                              [[thread_position_in_grid]]
) {
    const int w = int(src.get_width());
    const int h = int(src.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    int y0 = max(0, int(gid.y) - int(radius));
    int y1 = min(h - 1, int(gid.y) + int(radius));

    float acc = 0.0;
    int count = 0;
    for (int y = y0; y <= y1; ++y) {
        acc += float(src.read(uint2(gid.x, uint(y))).r);
        ++count;
    }
    half v = half(acc / float(count));
    dst.write(half4(v, 0, 0, 0), gid);
}
