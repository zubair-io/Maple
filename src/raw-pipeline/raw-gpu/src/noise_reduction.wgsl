// Tiled NLM in Oklab space. One workgroup loads an 8×8 output tile plus
// the P=2/S<=3 halo once; each pixel keeps all shift accumulators in registers.
// This removes 48 full-plane accumulator round-trips per chroma channel (#3363).
// Four storage bindings: source plane, Oklab L guide, output, and the exp LUT.
//
// Parity: retain raw-core's dy/dx order, local separable patch SSD, interpolated exp
// weights, DNG profile modulation, shifted-patch validity and max-weight center.
// CPU uses local separable sums; only float summation order differs (<1e-4).

// ── fast_neg_exp: bit-faithful to raw_core::stages::nlm::fast_neg_exp ──────────
//
// FAST_EXP_RANGE = 8.0, FAST_EXP_TABLE_SIZE = 512. The table index is
// `t = x · (TABLE_SIZE / RANGE) = x · 64`, `i = floor(t)`, `frac = t - i`. The
// table stores exp(-(i / 64)), computed once on the host and retained on GPU.
// This preserves the CPU lookup while removing two exponentials per shift/pixel.
const FAST_EXP_RANGE: f32 = 8.0;
const FAST_EXP_INV_STEP: f32 = 512.0 / 8.0; // TABLE_SIZE / RANGE

fn fast_neg_exp(x: f32) -> f32 {
    // x is always >= 0 (it's `ssd · inv_norm`, both non-negative). The `>=` bound
    // mirrors raw-core (so the i+1 endpoint never runs past the table tail).
    if (x >= FAST_EXP_RANGE) {
        return 0.0;
    }
    let t = x * FAST_EXP_INV_STEP;
    let i = floor(t);
    let frac = t - i;
    let a = nlm_exp[u32(i)];
    let b = nlm_exp[u32(i) + 1u];
    return a + (b - a) * frac;
}

// ── Oklab round-trip (mirrors raw-core::color::oklab; concat'd matrices) ───────
//
// The generated `color_matrices.wgsl` (prepended at compile time) supplies the
// `mul_*` helpers. Identical to vibrance.wgsl's pair — the canonical Oklab
// round-trip every fan-out stage reuses.
fn cbrt_signed(x: f32) -> f32 {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn rec2020_to_oklab(rgb: vec3<f32>) -> vec3<f32> {
    let srgb = mul_rec2020_to_srgb(rgb);
    let lms = mul_srgb_to_lms(srgb);
    let lms_cube = vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z));
    return mul_lms_to_lab(lms_cube);
}

fn oklab_to_rec2020(lab: vec3<f32>) -> vec3<f32> {
    let lms_cube = mul_lab_to_lms(lab);
    let lms = lms_cube * lms_cube * lms_cube; // cube — sign-preserving by construction
    let srgb = mul_lms_to_srgb(lms);
    return mul_srgb_to_rec2020(srgb);
}

// ── Plane extraction: RGBA → one Oklab channel ────────────────────────────────
//
// `channel` selects L (0), a (1), or b (2). One kernel serves luma (L) and color
// (a, b) by being dispatched once per needed channel. 2 storage (RGBA in, plane
// out).
struct ExtractParams {
    count: u32,
    channel: u32, // 0 = L, 1 = a, 2 = b
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> ex_params: ExtractParams;
@group(0) @binding(1) var<storage, read> ex_src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> ex_plane: array<f32>;

@compute @workgroup_size(64)
fn extract_channel(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= ex_params.count) {
        return;
    }
    let lab = rec2020_to_oklab(ex_src[i].rgb);
    ex_plane[i] = lab[ex_params.channel];
}

// ── Fused tiled plane filter ────────────────────────────────────────────────
struct NlmParams {
    width: u32,
    height: u32,
    p: i32,
    s: i32,
    h: f32,
    dynamic: u32,
    s_coeff: f32,
    o_coeff: f32,
};

@group(0) @binding(0) var<uniform> nlm_params: NlmParams;
@group(0) @binding(1) var<storage, read> nlm_plane: array<f32>;
@group(0) @binding(2) var<storage, read> nlm_l: array<f32>;
@group(0) @binding(3) var<storage, read_write> nlm_out: array<f32>;
@group(0) @binding(4) var<storage, read> nlm_exp: array<f32>;

// Current luma/chroma kernels use P=2, S=2/3. The host checks these ceilings
// before dispatch. An 18×18 tile covers 8×8 outputs plus a five-pixel halo.
var<workgroup> nlm_tile: array<f32, 324>;

// Per-shift squared differences over the 12×12 patch halo, followed by
// 8×12 horizontal five-tap sums. Both remain in workgroup memory.
var<workgroup> nlm_diff: array<f32, 144>;
var<workgroup> nlm_horizontal: array<f32, 96>;

@compute @workgroup_size(8, 8)
fn denoise_plane(
    @builtin(workgroup_id) group: vec3<u32>,
    @builtin(local_invocation_id) local: vec3<u32>,
    @builtin(local_invocation_index) lane: u32,
) {
    let width = i32(nlm_params.width);
    let height = i32(nlm_params.height);
    let origin = vec2<i32>(group.xy * 8u) - vec2<i32>(5);
    // Every lane participates, including partial edge tiles. No invocation can
    // return until the shared load and barrier complete. Zero halo values are
    // never sampled: the original and shifted patch must both fit the image.
    for (var i = lane; i < 324u; i += 64u) {
        let at = origin + vec2<i32>(i32(i % 18u), i32(i / 18u));
        var value = 0.0;
        if (at.x >= 0 && at.y >= 0 && at.x < width && at.y < height) {
            value = nlm_plane[u32(at.y * width + at.x)];
        }
        nlm_tile[i] = value;
    }
    workgroupBarrier();

    let position = vec2<i32>(group.xy * 8u + local.xy);
    let x = position.x;
    let y = position.y;
    let valid = x < width && y < height;
    let idx = u32(y * width + x);
    let tx = i32(local.x) + 5;
    let ty = i32(local.y) + 5;
    let center = nlm_tile[u32(ty * 18 + tx)];
    let p = nlm_params.p;
    let s = nlm_params.s;

    var scale = 1.0;
    if (valid && nlm_params.dynamic != 0u) {
        let local_l = clamp(nlm_l[idx], 0.0, 10.0);
        let variance = nlm_params.s_coeff * local_l + nlm_params.o_coeff;
        scale = clamp(sqrt(max(variance, 0.0)) / 0.002366, 0.1, 10.0);
    }
    // Rust rounds ties away from zero; WGSL round uses ties to even. Keep the
    // explicit non-negative rule because this rounding changes shift inclusion.
    let s_f = f32(s) * scale;
    let s_floor = floor(s_f);
    let s_round = select(s_floor, s_floor + 1.0, s_f - s_floor >= 0.5);
    let local_s = clamp(i32(s_round), 1, s);
    let local_h = nlm_params.h * scale;
    let patch_area = f32((2 * p + 1) * (2 * p + 1));
    let inv_norm = 1.0 / (local_h * local_h * patch_area);
    var acc = 0.0;
    var wsum = 0.0;
    var max_w = 0.0;

    // All lanes execute the same shift/barrier sequence, even in partial tiles
    // and when their profile rejects a shift. Only the final accumulation is
    // gated per pixel. dy/dx retain the CPU's addition order.
    for (var dy = -s; dy <= s; dy += 1) {
        for (var dx = -s; dx <= s; dx += 1) {
            if (dx == 0 && dy == 0) {
                continue;
            }
            // Compute each patch-halo difference once, shared by neighboring
            // outputs. Both source and shifted sample are inside the 18×18 tile.
            for (var i = lane; i < 144u; i += 64u) {
                let qx = i32(i % 12u) + 3;
                let qy = i32(i / 12u) + 3;
                let diff = nlm_tile[u32(qy * 18 + qx)]
                    - nlm_tile[u32((qy + dy) * 18 + qx + dx)];
                nlm_diff[i] = diff * diff;
            }
            workgroupBarrier();
            // Five horizontal taps, then five vertical taps: the same local
            // box sum as raw-core, without a full-frame scratch plane or the
            // rounding drift of an unbounded running/prefix accumulator.
            for (var i = lane; i < 96u; i += 64u) {
                let row = (i / 8u) * 12u + i % 8u;
                var sum = nlm_diff[row];
                sum += nlm_diff[row + 1u];
                sum += nlm_diff[row + 2u];
                sum += nlm_diff[row + 3u];
                sum += nlm_diff[row + 4u];
                nlm_horizontal[i] = sum;
            }
            workgroupBarrier();
            if (valid && x >= p && y >= p && x < width - p && y < height - p
                && x + dx >= p && x + dx < width - p
                && y + dy >= p && y + dy < height - p
                && abs(dx) <= local_s && abs(dy) <= local_s) {
                let row = local.y * 8u + local.x;
                var ssd = nlm_horizontal[row];
                ssd += nlm_horizontal[row + 8u];
                ssd += nlm_horizontal[row + 16u];
                ssd += nlm_horizontal[row + 24u];
                ssd += nlm_horizontal[row + 32u];
                let weight = fast_neg_exp(ssd * inv_norm);
                let shifted = nlm_tile[u32((ty + dy) * 18 + tx + dx)];
                acc += weight * shifted;
                wsum += weight;
                max_w = max(max_w, weight);
            }
            // The next shift's first barrier finishes these horizontal reads
            // before any lane overwrites horizontal sums. No third barrier is
            // needed: its preceding writes touch only the separate diff array.
        }
    }
    // Preserve Buades' center contribution and arithmetic for untouched borders.
    let mw = max(max_w, 1e-12);
    if (valid) {
        nlm_out[idx] = (acc + mw * center) / (wsum + mw);
    }
}

// ── Writeback (luma): RGBA-src + denoised L → RGBA-dst ────────────────────────
//
// Reconstruct each pixel as oklab_to_rec2020([new_L, a, b]) where a, b are
// recomputed from the ORIGINAL src pixel (not stored — recompute avoids two more
// bindings). 3 storage: src (read) + denoised-L (read) + dst (write).
struct WbParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> wbl_params: WbParams;
@group(0) @binding(1) var<storage, read> wbl_src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> wbl_l: array<f32>;
@group(0) @binding(3) var<storage, read_write> wbl_dst: array<vec4<f32>>;

@compute @workgroup_size(64)
fn writeback_luma(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= wbl_params.count) {
        return;
    }
    let src = wbl_src[i];
    let lab = rec2020_to_oklab(src.rgb);
    let out_rgb = oklab_to_rec2020(vec3<f32>(wbl_l[i], lab.y, lab.z));
    wbl_dst[i] = vec4<f32>(out_rgb, src.a);
}

// ── Writeback (color): RGBA-src + denoised a + denoised b → RGBA-dst ──────────
//
// Reconstruct as oklab_to_rec2020([L, new_a, new_b]) where L is recomputed from
// the original src pixel. 4 storage: src (read) + denoised-a (read) +
// denoised-b (read) + dst (write).
@group(0) @binding(0) var<uniform> wbc_params: WbParams;
@group(0) @binding(1) var<storage, read> wbc_src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> wbc_a: array<f32>;
@group(0) @binding(3) var<storage, read> wbc_b: array<f32>;
@group(0) @binding(4) var<storage, read_write> wbc_dst: array<vec4<f32>>;

@compute @workgroup_size(64)
fn writeback_color(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= wbc_params.count) {
        return;
    }
    let src = wbc_src[i];
    let lab = rec2020_to_oklab(src.rgb);
    let out_rgb = oklab_to_rec2020(vec3<f32>(lab.x, wbc_a[i], wbc_b[i]));
    wbc_dst[i] = vec4<f32>(out_rgb, src.a);
}
