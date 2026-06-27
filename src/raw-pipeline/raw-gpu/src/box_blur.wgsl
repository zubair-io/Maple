// box_blur.wgsl — separable box blur of a SCALAR f32 plane, one axis per
// dispatch (epic #925 P2 wave 3b / #990). THE reusable spatial primitive the
// guided-filter stages (clarity / texture) and the P3 spatial filters build on.
//
// PARITY-CRITICAL — mirrors `raw_core::stages::blur::box_blur_channel` EXACTLY.
// raw-core runs a serial running accumulator whose window at column `x` (the
// horizontal sweep) spans `[max(0, x - r) ..= min(w - 1, x + r)]` and divides by
// the EXACT count of in-bounds samples in that span. This is a SHRINKING partial
// average at the borders — NOT zero-pad, NOT clamp-to-edge. The vertical sweep is
// the same with `(y, h)` substituted for `(x, w)`. raw-core does H then V (two
// `box_blur_channel`-internal sweeps); we expose ONE axis per dispatch so the
// caller chains H then V (the V dispatch reads the H output).
//
// We compute a FRESH window sum per pixel over those exact bounds rather than
// replicate the running accumulator: the math is identical (same samples, same
// count), and float summation order is the only difference — a ~1e-6..1e-5
// effect, well under the 1e-4 parity gate.

struct Params {
    width: u32,
    height: u32,
    radius: u32,
    axis: u32,    // 0 = horizontal sweep, 1 = vertical sweep
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> output_buf: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let w = params.width;
    let h = params.height;
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= w * h) {
        return;
    }
    let r = i32(params.radius);

    // Recover (x, y) from the flat row-major index.
    let x = i32(i % w);
    let y = i32(i / w);

    // Window bounds along the swept axis: [max(0, c - r) ..= min(dim - 1, c + r)].
    // `count` is the EXACT span length — the shrinking partial-average border
    // policy `box_blur_channel` uses (its running `count` is incremented only
    // while a sample is in-bounds).
    var c: i32;
    var dim: i32;
    if (params.axis == 0u) {
        c = x;
        dim = i32(w);
    } else {
        c = y;
        dim = i32(h);
    }
    let lo = max(0, c - r);
    let hi = min(dim - 1, c + r);

    var acc: f32 = 0.0;
    if (params.axis == 0u) {
        // Horizontal: vary the column, hold the row.
        let base = u32(y) * w;
        for (var xi: i32 = lo; xi <= hi; xi = xi + 1) {
            acc = acc + input_buf[base + u32(xi)];
        }
    } else {
        // Vertical: vary the row, hold the column.
        for (var yi: i32 = lo; yi <= hi; yi = yi + 1) {
            acc = acc + input_buf[u32(yi) * w + u32(x)];
        }
    }
    let count = f32(hi - lo + 1);
    output_buf[i] = acc / count;
}
