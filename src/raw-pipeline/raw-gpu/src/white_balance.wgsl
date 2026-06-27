// white_balance.wgsl — scene-linear Rec.2020 white balance (raw-core spec § 3.5).
//
// A P2 scene-linear stage (epic #925 / #990), mirroring the vibrance template.
// The ENTIRE white-balance derivation (CAT16 cone-space adaptation, or the
// legacy diagonal per-channel gains) runs ON THE CPU once, producing a single
// linear-Rec.2020 → linear-Rec.2020 3×3 matrix; this kernel only applies that
// matrix per pixel. This is exactly what raw-core does:
// `white_balance::apply` derives the matrix via `wb_cat16_matrix` (or builds a
// diagonal from `wb_gains`) and then runs `apply_matrix_inplace` — one matmul
// per pixel. The diagonal path is just a diagonal matrix, so this single matmul
// kernel covers both `WbMethod`s with no branch.
//
// ## Matrix layout — why three vec4 ROWS, not a mat3x3
//
// The matrix arrives as three `vec4<f32>` rows (xyz = the row, w = padding) and
// the kernel does `dot(row, rgb)` per output channel. We deliberately do NOT use
// a `mat3x3<f32>` uniform: WGSL stores `mat3x3` COLUMN-major with a 16-byte
// column stride, so feeding it row-major Rust data would silently transpose the
// matrix and break parity. The explicit-row `dot` form matches
// `raw_core::math::Matrix3::mul_vec` (row-major) exactly — the same convention
// the generated `mul_*` color-matrix helpers use.

struct Params {
    // Three rows of the 3×3 WB matrix (row-major). `.xyz` is the row; `.w` is
    // padding (vec4 keeps each row 16-byte aligned for the uniform).
    row0: vec4<f32>,
    row1: vec4<f32>,
    row2: vec4<f32>,
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= params.count) {
        return;
    }
    let px = input_buf[i];
    let rgb = px.rgb;

    // Row-major 3×3 matmul — identical to Matrix3::mul_vec. Alpha untouched.
    let out_rgb = vec3<f32>(
        dot(params.row0.xyz, rgb),
        dot(params.row1.xyz, rgb),
        dot(params.row2.xyz, rgb),
    );
    output_buf[i] = vec4<f32>(out_rgb, px.a);
}
