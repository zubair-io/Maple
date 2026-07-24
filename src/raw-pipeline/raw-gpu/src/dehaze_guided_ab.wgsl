// dehaze_guided_ab.wgsl — the GENERAL guided-filter linear-coefficient
// derivation for dehaze (epic #925 P2 wave 3b / #990).
//
// Unlike clarity/texture's self-guided `guided_ab.wgsl` (where guide == p, so
// mean_p == mean_i and mean_ip == mean_ii collapse), dehaze's guide (luma) and
// filtered signal (transmission) DIFFER, so all four means are independent. They
// arrive PACKED in two vec2 planes (see dehaze_products.wgsl):
//   mean_m1 = (mean_i,  mean_p)    = (blur(luma),  blur(t))
//   mean_m2 = (mean_ip, mean_ii)   = (blur(luma·t), blur(luma·luma))
// and the coefficients are written packed as ab = (a, b).
//
// PARITY-CRITICAL — mirrors `raw_core::stages::dehaze::guided_filter`'s general
// path, operation order verbatim:
//   cov_ip = mean_ip - mean_i * mean_p
//   var_i  = max(mean_ii - mean_i * mean_i, 0.0)
//   a      = cov_ip / (var_i + eps)
//   b      = mean_p - a * mean_i
// (eps = 1e-3, raw-core's dehaze guided-filter regularisation.) var_i is
// clamped at zero to absorb box-blur roundoff — at scene-linear magnitudes
// ≫ 1 the cancellation can go slightly negative, flipping the sign of the
// `var_i + eps` denominator and blowing `a` up unboundedly; cov_ip stays
// unclamped (matches guided_ab.wgsl's precedent).

struct Params {
    count: u32,   // number of plane samples (width * height)
    eps: f32,     // guided-filter regularisation (1e-3 for dehaze)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> mean_m1_buf: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> mean_m2_buf: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> ab_buf: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let m1 = mean_m1_buf[i];   // (mean_i, mean_p)
    let m2 = mean_m2_buf[i];   // (mean_ip, mean_ii)
    let mean_i = m1.x;
    let mean_p = m1.y;
    let mean_ip = m2.x;
    let mean_ii = m2.y;
    let cov_ip = mean_ip - mean_i * mean_p;
    let var_i = max(mean_ii - mean_i * mean_i, 0.0);
    let a = cov_ip / (var_i + params.eps);
    let b = mean_p - a * mean_i;
    ab_buf[i] = vec2<f32>(a, b);
}
