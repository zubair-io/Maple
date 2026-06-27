// guided_ab.wgsl — the guided-filter linear-coefficient derivation (epic #925
// P2 wave 3b / #990). Shared by clarity / texture.
//
// From the box-blurred planes `mean_i` (= blur(luma)) and `mean_ii`
// (= blur(luma²)), derives the per-pixel guided-filter coefficients `a` and `b`.
//
// PARITY-CRITICAL — mirrors `raw_core::stages::blur::guided_filter`, SELF-GUIDED
// case (guide == p == luma). Because guide and p are the SAME buffer, raw-core's
// `mean_i == mean_p` and `mean_ip == mean_ii` bit-identically (same input, same
// deterministic blur), so:
//   cov_ip = mean_ii - mean_i * mean_i      (== mean_ip - mean_i * mean_p)
//   var_i  = max(mean_ii - mean_i * mean_i, 0.0)
//            (#1088 negative-variance clamp — cov_ip stays UNclamped, exactly
//             like raw-core's general form where cov is a genuine covariance)
//   a = cov_ip / (var_i + eps)
//   b = mean_i - a * mean_i                 (== mean_p - a * mean_i)
// Operation order is kept verbatim so the result bit-matches raw-core.

struct Params {
    count: u32,   // number of plane samples (width * height)
    eps: f32,     // guided-filter regularisation (1e-3 for clarity & texture)
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> mean_i_buf: array<f32>;
@group(0) @binding(2) var<storage, read> mean_ii_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> a_buf: array<f32>;
@group(0) @binding(4) var<storage, read_write> b_buf: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let mean_i = mean_i_buf[i];
    let mean_ii = mean_ii_buf[i];
    let cov_ip = mean_ii - mean_i * mean_i;
    // Negative-variance clamp (#1088) — mirrors raw-core's
    // `(mean_ii - mean_i * mean_i).max(0.0)`; cov_ip stays unclamped.
    let var_i = max(mean_ii - mean_i * mean_i, 0.0);
    let a = cov_ip / (var_i + params.eps);
    let b = mean_i - a * mean_i;
    a_buf[i] = a;
    b_buf[i] = b;
}
