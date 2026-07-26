// noise_reduction.wgsl — fast non-local-means denoising, Oklab-space adapter
// (epic #925 P3 wave 1 / #991). The P3 SPATIAL template: a search-window /
// patch-window neighbourhood filter that stays ONE chain Pass and orchestrates
// its own shift sub-passes over scratch planes (the dehaze precedent).
//
// PARITY CONTRACT — mirrors `raw_core::stages::nlm::denoise_plane` (the kernel)
// wrapped by `raw_core::stages::noise_reduction::{apply_luminance,apply_color}`
// (the Oklab adapter), `< 1e-4`.
//
// ## Why we recompute the patch-SSD directly (no materialised intermediate)
//
// raw-core collapses the (2P+1)² patch-SSD inner loop with a per-shift separable
// sliding box-sum (#1195; formerly a per-shift integral image). Either way the
// patch SSD equals the sum of `(I(q) - I(q+d))²` over the (2P+1)² patch — so we
// recompute that sum DIRECTLY in the accumulate kernel (a nested patch loop),
// reading only the plane. This is BUFFER-FORCED, not a perf choice: binding a
// materialised box-sum/integral plane alongside the accumulators would be
// `plane + aux + acc + wsum + max_w` = 5 storage buffers, over the
// `downlevel_defaults()` 4-storage cap. Direct-sum binds `plane + acc + wsum +
// max_w` = 4. (Perf is P4; this is correctness-only.) The only numerical delta
// from raw-core is float summation ORDER of the same (2P+1)² non-negative terms;
// since raw-core's box-sum forms the SAME local sum (no global prefix), the
// plane-parity max abs diff is ~5e-8 — well under the 1e-4 gate.
//
// ## Per-pixel noise-profile modulation, and where its extra plane comes from
//
// With a DNG NoiseProfile present, raw-core does NOT filter with one global `h`:
// per pixel it derives `var = s_coeff·L + o_coeff` from the Oklab L plane, takes
// `scale = clamp(sqrt(var)/0.002366, 0.1, 10)`, and filters that pixel with
// `local_h = h·scale` and a shrunk search radius `local_s = clamp(round(S·scale),
// 1, S)` (`raw_core::stages::nlm::denoise_plane_cancellable`). Shot noise grows
// with signal, so a bright pixel gets a wider kernel than a shadow pixel — the
// whole point of the profile. The GPU used to push ONE `inv_norm` scalar per
// dispatch, which is that math only for a frame of uniform brightness (#1714).
//
// The per-pixel `scale` is a full extra plane, and the accumulate kernel was
// already at the 4-storage cap. Rather than add a 5th binding, we WIDEN the
// `max_w` accumulator to `vec2<f32>` and carry the scale in its second lane:
// `.x` = the running max weight (read-modify-written per shift, exactly as
// before), `.y` = the pixel's `scale` (written once by `prepare_scale`, read-only
// thereafter). Same four storage bindings — plane + acc + wsum + (max_w, scale) —
// and the same dehaze-precedent packing `alloc_plane_vec2` already exists for.
// `local_h` / `local_s` are re-derived from that scale in registers.
//
// The flat (no-profile) case is NOT a second code path: it is `scale ≡ 1`, which
// makes `local_h = h` and `local_s = S` identically — so one kernel serves both
// and the no-profile output is unchanged.
//
// ## Why the exp is `lerp(exp(-x_i), exp(-x_{i+1}), frac)`, not `exp(-x)`
//
// raw-core's weight is NOT `exp(-x)` — it is `fast_neg_exp`, a 512-entry LUT of
// grid-snapped `exp` endpoints with LINEAR interpolation between them, clamped to
// 0 for `x >= 8`. Calling `exp(-x)` directly would diverge from the LUT by its
// interpolation error (~3e-5 per weight × ~24 shifts > 1e-4). We reproduce the
// LUT's STRUCTURE exactly: snap to the same grid (`i = floor(x·64)`,
// step = 8/512), take `exp` at the two grid endpoints, lerp by `frac`. The only
// difference from raw-core is `exp` evaluated live on the GPU vs precomputed on
// the CPU — the same f32 `exp` to ~1 ULP, applied equally to both endpoints.

// ── fast_neg_exp: bit-faithful to raw_core::stages::nlm::fast_neg_exp ──────────
//
// FAST_EXP_RANGE = 8.0, FAST_EXP_TABLE_SIZE = 512. The table index is
// `t = x · (TABLE_SIZE / RANGE) = x · 64`, `i = floor(t)`, `frac = t - i`. The
// table stores `exp(-(i · RANGE / TABLE_SIZE)) = exp(-(i / 64))`. We compute
// those two endpoints live rather than from a uploaded buffer (which would be a
// 5th binding in the accumulate kernel).
const FAST_EXP_RANGE: f32 = 8.0;
const FAST_EXP_STEP: f32 = 8.0 / 512.0; // RANGE / TABLE_SIZE
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
    // Grid-snapped endpoints — exp at the SAME x values the CPU table stores.
    let a = exp(-(i * FAST_EXP_STEP));
    let b = exp(-((i + 1.0) * FAST_EXP_STEP));
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

// ── Per-pixel scale prepare (the noise-profile modulation plane) ──────────────
//
// Mirrors the `use_dynamic` block of `raw_core::stages::nlm::denoise_plane_cancellable`:
// from the Oklab L plane, `var = s_coeff · clamp(L, 0, 10) + o_coeff`, then
// `scale = clamp(sqrt(max(var, 0)) / 0.002366, 0.1, 10)`. `dynamic == 0` (no DNG
// NoiseProfile) writes `scale = 1`, which reproduces the flat `h` / full-`S`
// filter exactly. Also seeds the `max_w` lane to 0, so the accumulator needs no
// separate clear. 2 storage: L plane (read) + the packed (max_w, scale) plane.
struct PrepareParams {
    count: u32,
    dynamic: u32,   // 0 = flat (scale ≡ 1), 1 = DNG NoiseProfile modulation
    s_coeff: f32,   // noise-profile slope, luma- or chroma-combined
    o_coeff: f32,   // noise-profile offset, ditto
};

// raw-core's reference sigma: the per-pixel sigma that maps to scale = 1, i.e.
// the noise level the un-modulated `h` was tuned for.
const NOISE_SIGMA_REF: f32 = 0.002366;

@group(0) @binding(0) var<uniform> pr_params: PrepareParams;
@group(0) @binding(1) var<storage, read> pr_l: array<f32>;
@group(0) @binding(2) var<storage, read_write> pr_ms: array<vec2<f32>>;

@compute @workgroup_size(64)
fn prepare_scale(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= pr_params.count) {
        return;
    }
    var scale = 1.0;
    if (pr_params.dynamic != 0u) {
        let local_l = clamp(pr_l[i], 0.0, 10.0);
        let variance = pr_params.s_coeff * local_l + pr_params.o_coeff;
        let sigma = sqrt(max(variance, 0.0));
        scale = clamp(sigma / NOISE_SIGMA_REF, 0.1, 10.0);
    }
    pr_ms[i] = vec2<f32>(0.0, scale);
}

// ── Accumulate one shift (the per-shift NLM core) ─────────────────────────────
//
// For shift d = (dx, dy): each pixel p computes the patch-SSD against p+d by
// summing `(plane[q] - plane[q+d])²` over the (2P+1)² patch DIRECTLY from the
// plane (no integral image — see the header), weights it through `fast_neg_exp`,
// and accumulates into acc/wsum/max_w (read-modify-write across shifts). The CPU
// side pre-computes the valid pixel range [x_lo..x_hi]×[y_lo..y_hi] (mirroring
// raw-core's isize max/min) and skips dispatching empty-range shifts; the shader
// just bounds-checks. The per-pixel `h` scaling and the per-pixel search-radius
// gate come from the packed plane's `.y` lane (see the header). 4 storage: plane
// + acc + wsum + (max_w, scale).
struct AccumParams {
    width: u32,
    height: u32,
    p: i32,   // patch radius
    h: f32,   // filter strength BEFORE per-pixel modulation (`local_h = h · scale`)
    dx: i32,
    dy: i32,
    x_lo: i32,
    x_hi: i32,
    y_lo: i32,
    y_hi: i32,
    s: i32,   // search radius — the ceiling the per-pixel `local_s` clamps to
    _pad0: u32,
};

// Exactly four storage buffers — at the `downlevel_defaults()` cap. The uniform
// `ac_params` at binding 0 does NOT count against the storage cap.
@group(0) @binding(0) var<uniform> ac_params: AccumParams;
@group(0) @binding(1) var<storage, read> ac_plane: array<f32>;            // storage 1
@group(0) @binding(2) var<storage, read_write> ac_acc: array<f32>;        // storage 2
@group(0) @binding(3) var<storage, read_write> ac_wsum: array<f32>;       // storage 3
@group(0) @binding(4) var<storage, read_write> ac_ms: array<vec2<f32>>;   // storage 4
                                                                         // (.x max_w, .y scale)

@compute @workgroup_size(64)
fn accumulate_shift(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let idx = gid.y * ng.x * 64u + gid.x;
    let w = ac_params.width;
    let h = ac_params.height;
    if (idx >= w * h) {
        return;
    }
    let x = i32(idx % w);
    let y = i32(idx / w);
    // Only pixels whose patch AND shifted patch fit the image contribute (the
    // CPU-computed valid range). Outside it: leave acc/wsum/max_w untouched.
    if (x < ac_params.x_lo || x > ac_params.x_hi || y < ac_params.y_lo || y > ac_params.y_hi) {
        return;
    }

    let p = ac_params.p;
    let dx = ac_params.dx;
    let dy = ac_params.dy;
    let wi = i32(w);

    // Per-pixel noise-profile modulation (#1714). `scale` was computed once by
    // `prepare_scale`; both the search-radius gate and the exp normaliser follow
    // from it, exactly as raw-core's `local_s_plane` / `local_inv_norm_plane`.
    let scale = ac_ms[idx].y;
    // `local_s = clamp(round(S · scale), 1, S)`. WGSL `round` is half-to-EVEN
    // while Rust's `f32::round` is half-AWAY-from-zero, and this value is a
    // discrete shift gate — a one-ULP disagreement there changes which shifts a
    // pixel sees, not just its weight. `S · scale` is non-negative, so the Rust
    // rule is exactly "floor, then step up when the fraction reaches ½"; spelling
    // it out that way also avoids the `x + 0.5` formulation's rounding trap at
    // the largest float below ½.
    let s_f = f32(ac_params.s) * scale;
    let s_floor = floor(s_f);
    let s_round = select(s_floor, s_floor + 1.0, s_f - s_floor >= 0.5);
    let local_s = clamp(i32(s_round), 1, ac_params.s);
    if (abs(dx) > local_s || abs(dy) > local_s) {
        return;
    }

    // Direct patch-SSD: Σ over [-p..p]² of (plane[q] - plane[q+d])².
    var ssd: f32 = 0.0;
    for (var oy: i32 = -p; oy <= p; oy = oy + 1) {
        let qy = y + oy;
        let sy = qy + dy;
        let q_row = qy * wi;
        let s_row = sy * wi;
        for (var ox: i32 = -p; ox <= p; ox = ox + 1) {
            let qx = x + ox;
            let sx = qx + dx;
            let diff = ac_plane[u32(q_row + qx)] - ac_plane[u32(s_row + sx)];
            ssd = ssd + diff * diff;
        }
    }

    // `local_h = h · scale`, `inv_norm = 1 / (local_h² · patch_area)` — the same
    // expression order raw-core evaluates, so the flat `scale = 1` case reduces
    // to the pre-#1714 constant.
    let local_h = ac_params.h * scale;
    let patch_area = f32((2 * p + 1) * (2 * p + 1));
    let inv_norm = 1.0 / (local_h * local_h * patch_area);
    let weight = fast_neg_exp(ssd * inv_norm);
    let sx_c = x + dx;
    let sy_c = y + dy;
    let shifted = ac_plane[u32(sy_c * wi + sx_c)];

    ac_acc[idx] = ac_acc[idx] + weight * shifted;
    ac_wsum[idx] = ac_wsum[idx] + weight;
    ac_ms[idx].x = max(ac_ms[idx].x, weight);
}

// ── Finalize: out = (acc + mw·plane) / (wsum + mw), mw = max(max_w, 1e-12) ─────
//
// Buades' self-similarity correction: the centre pixel is added at the end with
// weight = running max weight. Written IN PLACE into acc (acc becomes the
// denoised plane) so the kernel stays at 4 storage: plane (read) + acc (rw) +
// wsum (read) + (max_w, scale) (read — only the `.x` lane matters here).
// Passthrough (wsum=max_w=0 in the border strip, and equally at any pixel whose
// `local_s` gate skipped every shift) falls out of the `max(…,1e-12)` clamp →
// out = plane; no special case.
struct FinalizeParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> fin_params: FinalizeParams;
@group(0) @binding(1) var<storage, read> fin_plane: array<f32>;
@group(0) @binding(2) var<storage, read_write> fin_acc: array<f32>;
@group(0) @binding(3) var<storage, read> fin_wsum: array<f32>;
@group(0) @binding(4) var<storage, read> fin_ms: array<vec2<f32>>;

@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= fin_params.count) {
        return;
    }
    let mw = max(fin_ms[i].x, 1e-12);
    let total_w = fin_wsum[i] + mw;
    let total_acc = fin_acc[i] + mw * fin_plane[i];
    fin_acc[i] = total_acc / total_w;
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
