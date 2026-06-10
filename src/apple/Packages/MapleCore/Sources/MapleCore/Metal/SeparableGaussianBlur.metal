// SeparableGaussianBlur.metal — shared 3-pass Gaussian-by-box-blur compute
// kernel. Mirrors `gaussian_blur_rgb` in src/raw-pipeline/raw-core/src/
// stages/blur.rs:89-114 (Wells 1986 approximation).
//
// Used by SceneClarity (radius 40) and SceneTexture (radius 3). The Swift
// wrapper `MetalKernels.applySeparableGaussianBlur(to:radius:)` orchestrates
// the 6-pass dispatch (H, V, H, V, H, V) on a single command buffer with
// two ping-pong fp16 RGBA textures.
//
// Per the Rust source: r_box = (radius / 3).max(1) is the integer box-pass
// radius; the kernel takes that pre-computed `r_box` as a buffer argument
// (so the Swift side does the same integer math as Rust).
//
// Edge handling: clamp-to-edge, identical to the Rust `right0 = r.min(w-1)`
// initial-window math at blur.rs:33-39 — the running sum is initialized
// over the visible window, no zero-pad. We restate that here as a
// per-pixel sum over [max(0, x-r), min(w-1, x+r)] inclusive (no running
// accumulator across thread groups — one thread per output pixel does
// its own bounded loop).
//
// **Performance note:** the brief at § 1 picks compute over CIKernel because
// the running-sum accumulator gives O(n) per pixel independent of radius
// (matching Rust's runtime profile). The naive per-thread bounded sum
// below is O(r) per pixel — fine for radius=3 (texture) but expensive at
// radius=40 (clarity). Follow-up plans (M3 onwards) can swap to a
// threadgroup-shared running-sum implementation once the parity tests
// lock the algorithm.
//
// **Compile path:** this is a pure Metal compute kernel (no `coreimage::`
// types, no `[[stitchable]]` attribute, no `extern "C"`). It is loaded via
// `MTLDevice.makeLibrary(source:options:)` from the `.metal` source text
// (verbatim file copy via Package.swift's `.copy("Metal")`). The CIImage
// chain in `MetalKernels.swift` calls `CIImage(mtlTexture:options:)` on
// the compute output (verified by Spike 1.1 to compose with downstream
// CIColorKernels).

#include <metal_stdlib>
using namespace metal;

// Horizontal box pass: each output pixel reads [max(0, x-r), min(w-1, x+r)]
// inclusive on the same row; averages all four channels independently.
kernel void separableBoxBlurH(
    texture2d<half, access::read>  src   [[texture(0)]],
    texture2d<half, access::write> dst   [[texture(1)]],
    constant uint& rBox                  [[buffer(0)]],
    uint2 gid                            [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    int x0 = int(gid.x) - int(rBox);
    int x1 = int(gid.x) + int(rBox);
    if (x0 < 0)        x0 = 0;
    if (x1 > int(w)-1) x1 = int(w) - 1;

    float4 acc = float4(0.0);
    int count = 0;
    for (int x = x0; x <= x1; ++x) {
        acc += float4(src.read(uint2(uint(x), gid.y)));
        ++count;
    }
    half4 out = half4(acc / float(count));
    dst.write(out, gid);
}

// Vertical box pass: same as horizontal but along Y. The Rust source's
// transpose is unnecessary on GPU because we do per-pixel writes with
// global coords; the H pass writes to a scratch texture, the V pass
// reads that scratch and writes to the final (or next ping-pong)
// texture.
kernel void separableBoxBlurV(
    texture2d<half, access::read>  src   [[texture(0)]],
    texture2d<half, access::write> dst   [[texture(1)]],
    constant uint& rBox                  [[buffer(0)]],
    uint2 gid                            [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    int y0 = int(gid.y) - int(rBox);
    int y1 = int(gid.y) + int(rBox);
    if (y0 < 0)        y0 = 0;
    if (y1 > int(h)-1) y1 = int(h) - 1;

    float4 acc = float4(0.0);
    int count = 0;
    for (int y = y0; y <= y1; ++y) {
        acc += float4(src.read(uint2(gid.x, uint(y))));
        ++count;
    }
    half4 out = half4(acc / float(count));
    dst.write(out, gid);
}

// --- True separable Gaussian (#1083) -------------------------------------
//
// Weighted 1D convolution against a CPU-precomputed windowed/renormalized
// Gaussian kernel, clamp-to-edge. Mirrors raw-core's
// `gaussian_blur_plane_sigma` (stages/blur.rs): out = Σ_k w[k] · src[clamp(c
// + k - half)]. The weights come from the Swift port of `gaussian_kernel_1d`
// (MetalKernels.gaussianKernel1D) so the taps match raw-core's f32 build.
//
// Used by `applySceneSharpen`'s PSF blur: the sharpen Radius slider is a
// float sigma (0.5..3.0), which the 3-pass box cascade above cannot express
// — its integer `r_box` collapsed every legal radius to the same 1-px box
// (the #1083 no-op). nr_color keeps the box cascade (its radius is a real
// integer scale, matching raw-core's `gaussian_blur_plane`).
//
// `tapCount` ≤ 19 for the sharpen sigma ceiling (half = ceil(3σ) ≤ 9).
// Reads/writes float4 directly (the textures are rgba32Float) — no fp16
// round-trip on the weighted sum.

kernel void separableTrueGaussianH(
    texture2d<float, access::read>  src      [[texture(0)]],
    texture2d<float, access::write> dst      [[texture(1)]],
    constant uint& tapCount                  [[buffer(0)]],
    constant float* weights                  [[buffer(1)]],
    uint2 gid                                [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    const int half_taps = int(tapCount) / 2;
    float4 acc = float4(0.0);
    for (int k = 0; k < int(tapCount); ++k) {
        int x = int(gid.x) + k - half_taps;
        x = clamp(x, 0, int(w) - 1);
        acc += weights[k] * src.read(uint2(uint(x), gid.y));
    }
    dst.write(acc, gid);
}

kernel void separableTrueGaussianV(
    texture2d<float, access::read>  src      [[texture(0)]],
    texture2d<float, access::write> dst      [[texture(1)]],
    constant uint& tapCount                  [[buffer(0)]],
    constant float* weights                  [[buffer(1)]],
    uint2 gid                                [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    const int half_taps = int(tapCount) / 2;
    float4 acc = float4(0.0);
    for (int k = 0; k < int(tapCount); ++k) {
        int y = int(gid.y) + k - half_taps;
        y = clamp(y, 0, int(h) - 1);
        acc += weights[k] * src.read(uint2(gid.x, uint(y)));
    }
    dst.write(acc, gid);
}
