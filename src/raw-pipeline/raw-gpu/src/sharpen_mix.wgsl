// sharpen_mix.wgsl — the edge-aware amount + masking blend (epic #925 P3 wave 2
// / #991). The tail of `raw_core::stages::sharpen::apply`: blend the observed
// image toward the full-strength sharpened buffer by `mix = overall_mix * edge`,
// where `edge` gates flat regions vs edges when masking is on.
//
// PARITY-CRITICAL — mirrors raw-core's edge-mix loop byte-for-byte:
//   if masking_threshold > 1e-3:
//       g      = sqrt(gx² + gy²)  with central-difference luma gradient
//                gx = luma[idx(x+1,y)] - luma[idx(x-1,y)]   (clamp-to-edge idx)
//                gy = luma[idx(x,y+1)] - luma[idx(x,y-1)]
//       g_norm = clamp(g / 0.2, 0, 1)
//       edge   = select(detail_atten, 1.0, g_norm >= masking_threshold)
//   else:
//       edge   = 1.0
//   mix = overall_mix * edge
//   out = observed + (sharpened - observed) * mix
//
// The gradient reads the ORIGINAL luma plane (not the blurred one) with the same
// `xi.clamp(0, w-1)` / `yi.clamp(0, h-1)` border policy raw-core's `idx` closure
// uses — clamp-to-edge, distinct from the box blur's shrinking window.
//
// 4 storage: src(observed RGBA) + sharpened(RGBA) + luma(plane) + dst(RGBA). The
// slider-derived scalars (overall_mix / detail_atten / masking_threshold), clamped
// CPU-side exactly as raw-core does, ride the uniform.

struct Params {
    width: u32,
    height: u32,
    overall_mix: f32,        // clamp(amount / 100, 0, 1.5)
    detail_atten: f32,       // clamp(detail / 100, 0, 1)
    masking_threshold: f32,  // clamp(masking / 100, 0, 1)
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> observed_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> sharpened_buf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> luma_buf: array<f32>;
@group(0) @binding(4) var<storage, read_write> output_buf: array<vec4<f32>>;

// luma[clamp(xi,0,w-1), clamp(yi,0,h-1)] — raw-core's `idx` closure.
fn luma_at(xi: i32, yi: i32, w: i32, h: i32) -> f32 {
    let xc = clamp(xi, 0, w - 1);
    let yc = clamp(yi, 0, h - 1);
    return luma_buf[u32(yc * w + xc)];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let idx = gid.y * ng.x * 64u + gid.x;
    let w = i32(params.width);
    let h = i32(params.height);
    if (idx >= params.width * params.height) {
        return;
    }
    let x = i32(idx % params.width);
    let y = i32(idx / params.width);

    var edge: f32;
    if (params.masking_threshold > 1e-3) {
        let gx = luma_at(x + 1, y, w, h) - luma_at(x - 1, y, w, h);
        let gy = luma_at(x, y + 1, w, h) - luma_at(x, y - 1, w, h);
        let g = sqrt(gx * gx + gy * gy);
        let g_norm = clamp(g / 0.2, 0.0, 1.0);
        if (g_norm >= params.masking_threshold) {
            edge = 1.0;
        } else {
            edge = params.detail_atten;
        }
    } else {
        edge = 1.0;
    }

    let mix = params.overall_mix * edge;
    let o = observed_buf[idx];
    let s = sharpened_buf[idx];
    output_buf[idx] = vec4<f32>(o.rgb + (s.rgb - o.rgb) * mix, o.a);
}
