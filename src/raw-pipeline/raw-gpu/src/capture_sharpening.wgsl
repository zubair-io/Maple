// capture_sharpening.wgsl — Richardson–Lucy deconvolution against a true
// Gaussian PSF, on a luminance plane (epic #925 P3 wave 2 / #991). Mirrors
// `raw_core::stages::capture_sharpening::apply_capture_sharpening`.
//
// Five entry points share this module (selected by the pipeline accessor):
//   extract_luma   — RGBA → Rec.709 luma plane.
//   gaussian_blur  — separable true-Gaussian blur, one axis per dispatch,
//                    CPU-uploaded kernel weights, CLAMP-TO-EDGE borders.
//   ratio_step     — ratio = clamp(original / max(blur_est, 1e-6), 0, 100).
//   multiply_step  — estimate *= blur_ratio (the RL update, in place).
//   apply_scale    — the highlight-faded per-channel scale → dst.
//
// PARITY-CRITICAL notes:
//
// * Rec.709 luma weights (0.2126, 0.7152, 0.0722) — raw-core's deliberate
//   approximation for this stage (LUM_WEIGHTS), NOT the Rec.2020 weights every
//   other stage uses. Parity is against raw-core, so use these verbatim.
//
// * The Gaussian is a TRUE windowed/renormalized Gaussian (gaussian_kernel_1d on
//   the CPU, uploaded here), NOT the box-blur approximation. Edge handling CLAMPS
//   the sample index to [0, dim-1] (raw-core's `.clamp(0, dim-1)`), distinct from
//   box_blur.wgsl's shrinking partial average. The conv loop iterates
//   `k_idx ∈ 0..len`, sampling `clamp(c + k_idx - half)`, in the SAME order as
//   raw-core's loop — so with bit-identical CPU-side weights the only delta is
//   float summation order (~1e-6).
//
// * apply_scale's two skip-paths (`y_old < 1e-6` and `blend <= 0`) MUST write
//   `dst = src`, not return: on the GPU `dst` is a separate buffer, so a bare
//   return would leave stale data. raw-core's in-place `return` leaves the pixel
//   == input, which on the GPU means an explicit src→dst copy.

// ── extract_luma: RGBA → Rec.709 luma plane ───────────────────────────────────
const LUM_R: f32 = 0.2126;
const LUM_G: f32 = 0.7152;
const LUM_B: f32 = 0.0722;

struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> ex_params: CountParams;
@group(0) @binding(1) var<storage, read> ex_src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> ex_luma: array<f32>;

@compute @workgroup_size(64)
fn extract_luma(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= ex_params.count) {
        return;
    }
    let p = ex_src[i];
    ex_luma[i] = LUM_R * p.r + LUM_G * p.g + LUM_B * p.b;
}

// ── gaussian_blur: separable true-Gaussian, clamp-to-edge, one axis/dispatch ───
//
// Mirrors `raw_core::stages::capture_sharpening::gaussian_blur_plane`. The kernel
// weights live in a CPU-uploaded storage buffer (bit-identical to
// `gaussian_kernel_1d` — both are Rust f32). `half = kernel.len() / 2`. The
// horizontal pass samples `clamp(x + k_idx - half, 0, w-1)`; the vertical pass
// samples `clamp(y + k_idx - half, 0, h-1)`. raw-core does H then V as two passes
// over a scratch; we expose one axis per dispatch so the caller chains them (the V
// dispatch reads the H output) — identical to the box-blur primitive's chaining.
struct GaussParams {
    width: u32,
    height: u32,
    klen: u32,    // kernel length (== 2*half + 1)
    axis: u32,    // 0 = horizontal sweep, 1 = vertical sweep
};

@group(0) @binding(0) var<uniform> g_params: GaussParams;
@group(0) @binding(1) var<storage, read> g_kernel: array<f32>;
@group(0) @binding(2) var<storage, read> g_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> g_out: array<f32>;

@compute @workgroup_size(64)
fn gaussian_blur(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let w = g_params.width;
    let h = g_params.height;
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= w * h) {
        return;
    }
    let x = i32(i % w);
    let y = i32(i / w);
    let klen = i32(g_params.klen);
    let half = klen / 2;
    let wi = i32(w);
    let hi = i32(h);

    var acc: f32 = 0.0;
    if (g_params.axis == 0u) {
        // Horizontal: out[y,x] = Σ_k kernel[k] * in[y, clamp(x + k - half)].
        let base = u32(y) * w;
        for (var k: i32 = 0; k < klen; k = k + 1) {
            let xi = clamp(x + k - half, 0, wi - 1);
            acc = acc + g_kernel[u32(k)] * g_in[base + u32(xi)];
        }
    } else {
        // Vertical: out[y,x] = Σ_k kernel[k] * in[clamp(y + k - half), x].
        for (var k: i32 = 0; k < klen; k = k + 1) {
            let yi = clamp(y + k - half, 0, hi - 1);
            acc = acc + g_kernel[u32(k)] * g_in[u32(yi) * w + u32(x)];
        }
    }
    g_out[i] = acc;
}

// ── ratio_step: dampened Richardson–Lucy ratio ────────────────────────────────
//
// Mirrors raw-core's dampened RL step (capture_sharpening.rs ~227-232):
//   raw_ratio = clamp(original / max(blur_est, 1e-6), 0, 100)
//   noise2    = noise_floor * noise_floor
//   b2        = blur_est * blur_est
//   dampen    = b2 / (b2 + noise2)          (→ 1.0 when noise_floor == 0)
//   ratio     = 1 + (raw_ratio - 1) * dampen
//
// When noise_floor <= 0 (noise2 == 0), the ratio collapses to raw_ratio (dampen
// = b2/b2 = 1 for any b > 0; at b == 0 the denom guard already fires). This
// matches raw-core's `if noise2 > 0 { dampened } else { raw_ratio }` branch.
struct RatioParams {
    count: u32,
    noise_floor: f32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> r_params: RatioParams;
@group(0) @binding(1) var<storage, read> r_original: array<f32>;
@group(0) @binding(2) var<storage, read> r_blur_est: array<f32>;
@group(0) @binding(3) var<storage, read_write> r_ratio: array<f32>;

@compute @workgroup_size(64)
fn ratio_step(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= r_params.count) {
        return;
    }
    let b = r_blur_est[i];
    let denom = max(b, 1e-6);
    let raw_ratio = clamp(r_original[i] / denom, 0.0, 100.0);
    let noise2 = r_params.noise_floor * r_params.noise_floor;
    // Mirror raw-core's `if noise2 > 0.0 { dampened } else { raw_ratio }`.
    // When noise2 == 0 we skip the branch to avoid the b2/(b2+0)=NaN edge case
    // at b == 0, and return raw_ratio exactly as the undampened path does.
    var result: f32;
    if (noise2 > 0.0) {
        let b2 = b * b;
        let dampen = b2 / (b2 + noise2);
        result = 1.0 + (raw_ratio - 1.0) * dampen;
    } else {
        result = raw_ratio;
    }
    r_ratio[i] = result;
}

// ── multiply_step: estimate *= blur_ratio (in place) ──────────────────────────
@group(0) @binding(0) var<uniform> m_params: CountParams;
@group(0) @binding(1) var<storage, read_write> m_estimate: array<f32>;
@group(0) @binding(2) var<storage, read> m_blur_ratio: array<f32>;

@compute @workgroup_size(64)
fn multiply_step(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= m_params.count) {
        return;
    }
    m_estimate[i] = m_estimate[i] * m_blur_ratio[i];
}

// ── apply_scale: highlight-faded per-channel scale → dst ───────────────────────
//
// Mirrors raw-core's final loop. `hi_thresh` is `highlight_threshold.min(0.999)`
// (clamped CPU-side, passed in the uniform — so the GPU never divides by zero in
// the `(1 - y_old) / (1 - hi_thresh)` ramp). BOTH skip-paths write `dst = src`.
struct ApplyParams {
    count: u32,
    strength: f32,
    hi_thresh: f32,  // highlight_threshold.min(0.999)
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> a_params: ApplyParams;
@group(0) @binding(1) var<storage, read> a_original: array<f32>;   // y_old (luma)
@group(0) @binding(2) var<storage, read> a_estimate: array<f32>;   // y_new (RL result)
@group(0) @binding(3) var<storage, read> a_src: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> a_dst: array<vec4<f32>>;

@compute @workgroup_size(64)
fn apply_scale(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) ng: vec3<u32>) {
    let i = gid.y * ng.x * 64u + gid.x;
    if (i >= a_params.count) {
        return;
    }
    let src = a_src[i];
    let y_old = a_original[i];

    // Shadow guard: small y_old left alone (raw-core's `if y_old < 1e-6 return`).
    if (y_old < 1e-6) {
        a_dst[i] = src;
        return;
    }

    var blend: f32;
    if (y_old < a_params.hi_thresh) {
        blend = a_params.strength;
    } else {
        let t = clamp((1.0 - y_old) / (1.0 - a_params.hi_thresh), 0.0, 1.0);
        blend = a_params.strength * t;
    }
    if (blend <= 0.0) {
        a_dst[i] = src;
        return;
    }

    let y_new = a_estimate[i];
    let y_target = y_old * (1.0 - blend) + y_new * blend;
    let scale = y_target / y_old;
    a_dst[i] = vec4<f32>(src.rgb * scale, src.a);
}
