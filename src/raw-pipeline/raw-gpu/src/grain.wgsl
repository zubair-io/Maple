// grain.wgsl — display-linear deterministic film grain (#1110, tone/zoom
// design § 10.2; raw_core::stages::grain::apply_windowed).
//
// Runs POST-AgX, before display_encode — display-domain, so the grain
// amplitude does not swing with exposure. Monochromatic: ONE noise value
// per pixel added to all three channels.
//
// DETERMINISM CONTRACT: the integer PCG hash below carries IDENTICAL
// constants to raw-core's `stages::grain` (GRAIN_SEED / pcg multipliers /
// the [-1,1] mapping). No RNG — the field is a pure function of the
// absolute pixel coordinate + params, so renders are reproducible and the
// parity gate pins this kernel to the CPU stage. Coordinates are absolute
// image pixels (origin uniform → tile-safe, pan-stable).
//
// Preview/export parity is STATISTICAL, not pointwise: pitch scales with
// the render's long edge, so each resolution re-samples the field (see
// the stage docs). Same-resolution renders are parity-exact.

struct Params {
    k: f32,          // GRAIN_K · amount / 100
    inv_pitch: f32,  // 1 / (lerp(1,6,size/100) · longEdge/2000)
    rho: f32,        // roughness / 100 (second-octave mix)
    count: u32,      // number of RGBA pixels in the buffer
    buf_width: u32,  // buffer row stride in pixels
    origin_x: u32,   // buffer's left edge in full-image pixels
    origin_y: u32,   // buffer's top edge in full-image pixels
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

// Fixed lattice seeds — verbatim from raw_core::stages::grain.
const GRAIN_SEED: u32 = 0x4D41504Cu;
const GRAIN_SEED2: u32 = GRAIN_SEED ^ 0x9E3779B9u;
// Rec.2020 luma weights (the pipeline-wide constant).
const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;

// One round of the PCG-style integer mix (Jarzynski–Olano pcg_hash).
// Constants are load-bearing — identical to the Rust stage. u32 arithmetic
// wraps in WGSL by spec, matching Rust's wrapping_* calls.
fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Hash a 2-D lattice point + seed to a uniform value in [-1, 1].
fn lattice(ix: u32, iy: u32, seed: u32) -> f32 {
    let h = pcg(ix + pcg(iy + seed));
    return f32(h) * (2.0 / 4294967295.0) - 1.0;
}

// Quintic smoothstep weight t³(t(6t − 15) + 10) (Perlin fade — C²).
fn quintic(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Quintic-smoothed 2-D value noise at lattice-space coords (u, v) ≥ 0.
// Mirrors the Rust `value_noise` float sequence exactly.
fn value_noise(u: f32, v: f32, seed: u32) -> f32 {
    let i = floor(u);
    let j = floor(v);
    let fu = u - i;
    let fv = v - j;
    let iu = u32(i);
    let jv = u32(j);
    let n00 = lattice(iu, jv, seed);
    let n10 = lattice(iu + 1u, jv, seed);
    let n01 = lattice(iu, jv + 1u, seed);
    let n11 = lattice(iu + 1u, jv + 1u, seed);
    let sx = quintic(fu);
    let sy = quintic(fv);
    let nx0 = n00 + (n10 - n00) * sx;
    let nx1 = n01 + (n11 - n01) * sx;
    return nx0 + (nx1 - nx0) * sy;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let x = i % params.buf_width;
    let y = i / params.buf_width;
    let px = params.origin_x + x;
    let py = params.origin_y + y;

    // The zero-mean grain field: base octave + rho-weighted second octave
    // at 2× frequency, normalized by 1 + rho. Mirrors `grain_noise`.
    let u = f32(px) * params.inv_pitch;
    let v = f32(py) * params.inv_pitch;
    let n1 = value_noise(u, v, GRAIN_SEED);
    let n2 = value_noise(u * 2.0, v * 2.0, GRAIN_SEED2);
    let n = (n1 + params.rho * n2) / (1.0 + params.rho);

    let p = input_buf[i];
    let yd = clamp(LUMA_R * p.r + LUMA_G * p.g + LUMA_B * p.b, 0.0, 1.0);
    let wl = clamp(4.0 * yd * (1.0 - yd), 0.0, 1.0);
    let delta = params.k * wl * n;
    output_buf[i] = vec4<f32>(p.rgb + vec3<f32>(delta), p.a);
}
