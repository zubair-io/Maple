// DehazeGuidedFilter.metal — guided-filter component kernels. Mirrors
// `guided_filter` at raw-core/src/stages/dehaze.rs:109-135.
//
// Five component kernels:
//
//   1. dehazeBuildIp(guide, p, ip)  — per-pixel multiply.
//   2. dehazeBuildII(guide, ii)     — per-pixel square.
//   3. dehazeCombineAB(meanI, meanP, meanIp, meanII, eps, packedAB)
//      — covariance, variance, and (a, b) computation; output packed
//        as (a, b) in the R/G channels of an RG16Float texture.
//   4. dehazeUnpackR(packedAB, dst) — read .r of packedAB, write to a
//      single-channel R16Float scratch (so the dehaze box-blur can
//      operate on each channel independently).
//   5. dehazeUnpackG(packedAB, dst) — same for .g.
//
// The Swift wrapper orchestrates: build_Ip -> boxBlur -> build_II ->
// boxBlur -> boxBlur(meanI) -> boxBlur(meanP) -> combineAB ->
// unpackR -> boxBlur(a -> meanA) -> unpackG -> boxBlur(b -> meanB).

#include <metal_stdlib>
using namespace metal;

kernel void dehazeBuildIp(
    texture2d<half, access::read>   guide   [[texture(0)]],
    texture2d<half, access::read>   p       [[texture(1)]],
    texture2d<half, access::write>  ip      [[texture(2)]],
    uint2 gid                                [[thread_position_in_grid]]
) {
    const int w = int(guide.get_width());
    const int h = int(guide.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float g = float(guide.read(gid).r);
    float pp = float(p.read(gid).r);
    ip.write(half4(half(g * pp), 0, 0, 0), gid);
}

kernel void dehazeBuildII(
    texture2d<half, access::read>   guide   [[texture(0)]],
    texture2d<half, access::write>  ii      [[texture(1)]],
    uint2 gid                                [[thread_position_in_grid]]
) {
    const int w = int(guide.get_width());
    const int h = int(guide.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float g = float(guide.read(gid).r);
    ii.write(half4(half(g * g), 0, 0, 0), gid);
}

kernel void dehazeCombineAB(
    texture2d<half, access::read>   meanI    [[texture(0)]],
    texture2d<half, access::read>   meanP    [[texture(1)]],
    texture2d<half, access::read>   meanIp   [[texture(2)]],
    texture2d<half, access::read>   meanII   [[texture(3)]],
    texture2d<half, access::write>  packedAB [[texture(4)]],
    constant float& eps                       [[buffer(0)]],
    uint2 gid                                 [[thread_position_in_grid]]
) {
    const int w = int(meanI.get_width());
    const int h = int(meanI.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    float mi  = float(meanI.read(gid).r);
    float mp  = float(meanP.read(gid).r);
    float mip = float(meanIp.read(gid).r);
    float mii = float(meanII.read(gid).r);

    float covIp = mip - mi * mp;
    float varI  = mii - mi * mi;
    float a     = covIp / (varI + eps);
    float b     = mp - a * mi;

    packedAB.write(half4(half(a), half(b), 0, 0), gid);
}

// Unpack R channel of packedAB to a single-channel R16Float dst.
kernel void dehazeUnpackR(
    texture2d<half, access::read>   packedAB [[texture(0)]],
    texture2d<half, access::write>  dst      [[texture(1)]],
    uint2 gid                                 [[thread_position_in_grid]]
) {
    const int w = int(packedAB.get_width());
    const int h = int(packedAB.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    half v = packedAB.read(gid).r;
    dst.write(half4(v, 0, 0, 0), gid);
}

// Unpack G channel of packedAB to a single-channel R16Float dst.
kernel void dehazeUnpackG(
    texture2d<half, access::read>   packedAB [[texture(0)]],
    texture2d<half, access::write>  dst      [[texture(1)]],
    uint2 gid                                 [[thread_position_in_grid]]
) {
    const int w = int(packedAB.get_width());
    const int h = int(packedAB.get_height());
    if (int(gid.x) >= w || int(gid.y) >= h) return;

    half v = packedAB.read(gid).g;
    dst.write(half4(v, 0, 0, 0), gid);
}
