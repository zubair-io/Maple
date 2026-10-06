// present_chain.wgsl — CHAIN-OUTPUT present (epic #925 / P4b-apple #1028,
// P4b-web #1029).
//
// The colour-correct sibling of `present.wgsl` (P1b's passthrough test pattern).
// A fullscreen triangle (3 vertices from @builtin(vertex_index), no vertex
// buffer) whose fragment shader SAMPLES the live chain's final f32-RGBA buffer
// (the output of `LiveSession::render_chain_to_f32` — sRGB-gamma-encoded
// sRGB-primary in [0, 1]) as a read-only storage buffer, applies the EXACT
// `dither_and_quantize` math, and writes the result to the display surface.
//
// ## Why this runs the dither in the fragment shader (not the compute kernel)
//
// `dither.wgsl` is the headless terminal: f32 → a packed-u32 STORAGE buffer the
// host reads back. The present path has no readback — it writes a surface
// texture — so the quantize is folded into the FS here. The 8-bit surface
// (`Bgra8Unorm`, NON-sRGB — see `pick_surface_format`) performs the float→u8
// conversion on store as `round(c * 255)`. To reproduce `dither_and_quantize`'s
// `(c*255 + off + 0.5).clamp(0,255) as u8` (an `as u8` TRUNCATION of a non-
// negative clamped value = round-half-up), the FS emits
//   `floor(clamp(c*255 + off + 0.5, 0, 255)) / 255.0`
// so the surface's own round-to-nearest maps the already-integral value back to
// the SAME byte. Any residual is ≤ 1 LSB (the float-eval ordering the plan
// sanctions); the host-side parity test (`present/tests.rs`) measures it.
//
// PARITY-CRITICAL invariants (mirrored verbatim from `dither.wgsl`):
//
// * (x, y) is recovered from the FRAGMENT POSITION, which wgpu defines in
//   framebuffer space with origin top-left and y increasing DOWNWARD — exactly
//   the row-major top-down layout the chain's f32 buffer uses (`i = y*width + x`,
//   `x = i % width`, `y = i / width`). The present surface dims are PINNED equal
//   to the image dims on the Rust side (`present_chain` asserts it), so
//   `px = u32(pos.x)`, `py = u32(pos.y)` index the f32 buffer 1:1 and the Bayer
//   cell lands on the same pixel as the headless dither.
// * The same Bayer offset is added to ALL THREE channels at a pixel (neutral
//   stays neutral). The matrix is the canonical 8×8 `B(8)`, identical to
//   `raw_core::view::dither::BAYER_8X8` (pinned by `dither.rs`'s cross-check).
// * Alpha is forced to 1.0 — the chain's f32 alpha is unused on a display
//   surface; an opaque write matches the layer's `isOpaque`/framebuffer-only
//   configuration.

struct Params {
    width: u32,   // surface width (and chain stride when src_width == 0)
    height: u32,  // surface height (bounds guard)
    // Chain-buffer dims when they DIFFER from the surface (#2587's half-res
    // fast pass presents a half session into the full-size surface through a
    // bilinear upscale). 0 = chain dims equal surface dims — the exact
    // pre-existing 1:1 load path, so Apple/web presents (which always pass 0)
    // are bit-identical to before.
    src_width: u32,
    src_height: u32,
    // Manual geometry (#3410): the DESTINATION → SOURCE homography, one row
    // per `vec4`, in the centred half-extent-normalized `[-1, 1]` space
    // `raw_core::stages::perspective::matrix` documents. `geom_row0.w` is the
    // active flag — 0 means "no manual geometry", and the FS then takes the
    // untouched pre-#3410 load paths byte-for-byte. `.w` on the other two rows
    // is unused padding (a `vec4` is the only 16-byte-aligned row shape a
    // uniform block accepts without an implicit-stride surprise).
    geom_row0: vec4<f32>,
    geom_row1: vec4<f32>,
    geom_row2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
// The chain's final f32-RGBA buffer (sRGB-gamma-encoded, [0, 1]), row-major.
@group(0) @binding(1) var<storage, read> chain_buf: array<vec4<f32>>;

@group(0) @binding(3) var<storage, read> blue_noise: array<u32>;

fn blue_noise_offset_lsb(x: u32, y: u32) -> f32 {
    let idx = (((y & 63u) * 64u) + (x & 63u));
    let cell = blue_noise[idx];
    return (f32(cell) + 0.5) / 4096.0 - 0.5;
}

// One channel's dither+quantize, mapped back to [0, 1] for the unorm surface.
// `floor(clamp(c*255 + off + 0.5, 0, 255))` is the SAME integer byte
// `dither_and_quantize` produces (`as u8` truncation of a non-negative clamped
// value); dividing by 255 yields the canonical unorm value the surface's
// round-to-nearest store reproduces exactly.
fn quantized_channel(c: f32, off: f32) -> f32 {
    return floor(clamp(c * 255.0 + off + 0.5, 0.0, 255.0)) / 255.0;
}

struct VsOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // Oversized triangle covering the whole clip volume (same construction as
    // `present.wgsl`). No UVs needed — the FS reads its pixel from the integral
    // framebuffer position, not an interpolated coordinate.
    var out: VsOut;
    let x = f32((vid << 1u) & 2u); // 0, 2, 0
    let y = f32(vid & 2u);         // 0, 0, 2
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

// Bilinear sample of the chain buffer at fractional source-pixel coordinates,
// reproducing `raw_core::stages::crop::bilinear::sample_rgba` EXACTLY — which
// is a hybrid, not plain clamp-to-edge: a footprint that has left the source
// entirely returns opaque black, while one still straddling the border clamps
// its individual taps. That distinction is what the CPU/GPU parity gate on the
// warped present measures, and getting it wrong shows up as a one-pixel bright
// fringe all the way around a keystoned frame.
fn sample_chain_warped(sx: f32, sy: f32, sw: u32, sh: u32) -> vec4<f32> {
    let wi = i32(sw);
    let hi = i32(sh);
    let x0f = floor(sx);
    let y0f = floor(sy);
    let x0 = i32(x0f);
    let y0 = i32(y0f);
    if (x0 + 1 < 0 || y0 + 1 < 0 || x0 >= wi || y0 >= hi) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let fx = sx - x0f;
    let fy = sy - y0f;
    let cx0 = u32(clamp(x0, 0, wi - 1));
    let cy0 = u32(clamp(y0, 0, hi - 1));
    let cx1 = u32(clamp(x0 + 1, 0, wi - 1));
    let cy1 = u32(clamp(y0 + 1, 0, hi - 1));
    let c00 = chain_buf[cy0 * sw + cx0];
    let c10 = chain_buf[cy0 * sw + cx1];
    let c01 = chain_buf[cy1 * sw + cx0];
    let c11 = chain_buf[cy1 * sw + cx1];
    return mix(mix(c00, c10, fx), mix(c01, c11, fx), fy);
}

// The manual-geometry warp (#3410): destination pixel → the chain-buffer colour
// that belongs there. Mirrors `raw_core::stages::perspective::warp`'s
// `source_for` + sampler, including the `w`-near-zero arm that renders a
// destination beyond the projective horizon as surround rather than dividing.
fn warped_chain_sample(px: u32, py: u32, sw: u32, sh: u32) -> vec4<f32> {
    let nx = (f32(px) + 0.5) / (f32(params.width) * 0.5) - 1.0;
    let ny = (f32(py) + 0.5) / (f32(params.height) * 0.5) - 1.0;
    let hw = params.geom_row2.x * nx + params.geom_row2.y * ny + params.geom_row2.z;
    if (abs(hw) < 1.0e-6) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let sxn = (params.geom_row0.x * nx + params.geom_row0.y * ny + params.geom_row0.z) / hw;
    let syn = (params.geom_row1.x * nx + params.geom_row1.y * ny + params.geom_row1.z) / hw;
    let sx = (sxn + 1.0) * (f32(sw) * 0.5) - 0.5;
    let sy = (syn + 1.0) * (f32(sh) * 0.5) - 0.5;
    return sample_chain_warped(sx, sy, sw, sh);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Framebuffer-space pixel (top-left origin, y down) → the row-major f32 index.
    let px = u32(in.pos.x);
    let py = u32(in.pos.y);
    // Defensive bounds guard (the fullscreen triangle only covers the configured
    // surface, so this never trips in practice, but a clamp avoids any OOB read
    // if the rasterizer ever emits an edge fragment one texel past the surface).
    if (px >= params.width || py >= params.height) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let off = blue_noise_offset_lsb(px, py);
    var c: vec4<f32>;
    let src_w = select(params.src_width, params.width, params.src_width == 0u);
    let src_h = select(params.src_height, params.height, params.src_width == 0u);
    if (params.geom_row0.w != 0.0) {
        // Manual geometry armed: ONE resample from the chain grid, whatever
        // the surface/chain size relationship is — the normalized space the
        // homography lives in already absorbs a half-res chain buffer, so this
        // arm subsumes the upscale below rather than stacking on top of it.
        c = warped_chain_sample(px, py, src_w, src_h);
    } else if (params.src_width == 0u
        || (params.src_width == params.width && params.src_height == params.height)) {
        // 1:1 — the original path, untouched (parity-critical for Apple/web).
        let i = py * params.width + px;
        c = chain_buf[i];
    } else {
        // Bilinear upscale from the smaller chain grid (clamp-to-edge). The
        // interpolation happens on the f32 chain values BEFORE the dither +
        // quantize below, and the dither offset stays in SURFACE space so the
        // blue-noise cell is per-displayed-pixel like the 1:1 path.
        // max(..., 0.0) BEFORE floor: at the left/top edge the centre offset
        // makes the continuous coordinate negative, and flooring that would
        // yield frac 0.75 against a clamped x0 — bleeding the neighbour into
        // the edge pixel instead of clamp-to-edge holding it.
        let sx = max((f32(px) + 0.5) * f32(params.src_width) / f32(params.width) - 0.5, 0.0);
        let sy = max((f32(py) + 0.5) * f32(params.src_height) / f32(params.height) - 0.5, 0.0);
        let x0f = floor(sx);
        let y0f = floor(sy);
        let fx = sx - x0f;
        let fy = sy - y0f;
        let max_x = params.src_width - 1u;
        let max_y = params.src_height - 1u;
        let x0 = min(u32(x0f), max_x);
        let y0 = min(u32(y0f), max_y);
        let x1 = min(x0 + 1u, max_x);
        let y1 = min(y0 + 1u, max_y);
        let c00 = chain_buf[y0 * params.src_width + x0];
        let c10 = chain_buf[y0 * params.src_width + x1];
        let c01 = chain_buf[y1 * params.src_width + x0];
        let c11 = chain_buf[y1 * params.src_width + x1];
        c = mix(mix(c00, c10, fx), mix(c01, c11, fx), fy);
    }
    return vec4<f32>(
        quantized_channel(c.r, off),
        quantized_channel(c.g, off),
        quantized_channel(c.b, off),
        1.0,
    );
}
