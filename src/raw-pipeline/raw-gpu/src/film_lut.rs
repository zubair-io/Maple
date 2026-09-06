//! Film-look 3D LUT WGSL port — a display-linear view-tail stage (epic #2683,
//! Task 7).
//!
//! Ports `raw_core::stages::film_look::apply` (Task 6): a baked film-print
//! `.mlut` lattice ([`raw_core::film::FilmLut`], Task 1) sampled by
//! **tetrahedral** interpolation in the "encoded sRGB lattice" domain a
//! `.mlut` is built in, then blended back into the display-linear Rec.2020
//! working space by `strength`. Runs post-`color_grade`, pre-`grain` — the
//! same display-linear position [`crate::grain`] occupies.
//!
//! ## Per-pixel chain (mirrors `film_look::apply_pixel` line-for-line)
//!
//! ```text
//! original  = px                                     // display-linear Rec.2020
//! s_lin     = M_REC2020_TO_SRGB · original            // linear sRGB (can exceed [0,1])
//! enc       = clamp(srgb_gamma(s_lin), 0, 1)          // lattice domain — encoded sRGB
//! f_enc     = tetra_sample(lut, enc)                  // the baked film print
//! f_lin     = srgb_degamma(f_enc)                     // back to linear sRGB
//! f_2020    = M_SRGB_TO_REC2020 · f_lin                // back to Rec.2020 primaries
//! t         = clamp(strength / 100, 0, 1)
//! output    = original + (f_2020 − original) · t      // blend toward the film arm
//! ```
//!
//! Three pieces (the per-stage template, mirroring `residual_lut` / `grain`):
//! 1. [`apply_film_lut`] — the CPU oracle: a line-for-line port of
//!    `film_look::apply_pixel` over a flat interleaved RGBA f32 buffer (alpha
//!    untouched). The matrix + gamma constants are transcribed locally
//!    (raw-core is a dev-dep only) — the parity test pins them to the real
//!    stage.
//! 2. [`FilmLutPass`] — the GPU-resident [`Pass`]; carries the flat film LUT
//!    grid, its node count, and the strength slider. The kernel needs the
//!    generated color-matrix module (`mul_rec2020_to_srgb` /
//!    `mul_srgb_to_rec2020`), so it compiles via `compile_with_matrices` —
//!    same concat pattern as `vibrance` / `display_encode`. Uploads the grid
//!    to storage binding 3 and `count` / `size` / `strength` to uniform
//!    binding 0 inside `encode`.
//! 3. The headless parity test ([`mod tests`], in `film_lut/tests.rs`) — GPU
//!    vs the real `raw_core::stages::film_look::apply` (via the test-only
//!    `raw-core` dev-dep) `< 1e-4`.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

// ── Color math + gamma (duplicated from raw_core, mirrors `display_encode.rs` /
//    `srgb_gamma.wgsl`'s established local-transcription pattern) ──────────

type Mat3 = [[f32; 3]; 3];

/// Verbatim copy of `raw_core::color::matrices::M_REC2020_TO_SRGB`.
const M_REC2020_TO_SRGB: Mat3 = [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
];
/// Verbatim copy of `raw_core::color::matrices::M_SRGB_TO_REC2020` (the exact
/// numeric inverse of `M_REC2020_TO_SRGB`, pre-folded for the hot path).
const M_SRGB_TO_REC2020: Mat3 = [
    [0.6274094, 0.3292603, 0.0432719],
    [0.0691248, 0.9195486, 0.0113208],
    [0.0164234, 0.0880478, 0.8956167],
];

#[inline]
fn mul3(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Verbatim copy of `raw_core::view::gamma::srgb_gamma` (piecewise sRGB
/// OETF; clamps to `[0, 1]` FIRST, matching the Rust fn exactly).
#[inline]
fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// Verbatim copy of `raw_core::view::gamma::srgb_degamma` (piecewise sRGB
/// EOTF; no input clamp, matching the Rust fn — the lattice sample it
/// consumes is already `[0, 1]` by construction).
#[inline]
fn srgb_degamma(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

/// Number of floats in a `size`³ RGB grid. Mirrors `residual_lut_flat_len`.
#[inline]
pub fn film_lut_flat_len(size: usize) -> usize {
    size * size * size * 3
}

/// One grid node's RGB triplet. Mirrors `raw_core::film::tetra_sample`'s
/// private `node` closure: manual flat index, no bounds clamp (the caller
/// caps `lo` at `last - 1`, so `lo + 1` never exceeds `size - 1`).
#[inline]
fn node(data: &[f32], size: usize, r: usize, g: usize, b: usize) -> [f32; 3] {
    let i = ((b * size + g) * size + r) * 3;
    [data[i], data[i + 1], data[i + 2]]
}

/// Tetrahedral lookup of one RGB triplet (inputs clamped to `[0, 1]`). A
/// line-for-line port of `raw_core::film::tetra_sample` — same `lo`/`f`
/// derivation and the same 6-case barycentric split of the unit cube (by the
/// ordering of `fx`/`fy`/`fz`), using only 4 of the 8 corner nodes per
/// sample. NOT trilinear (#1737).
fn tetra_sample(data: &[f32], size: usize, rgb: [f32; 3]) -> [f32; 3] {
    let last = (size - 1) as f32;
    let mut lo = [0usize; 3];
    let mut f = [0f32; 3];
    for c in 0..3 {
        let p = rgb[c].clamp(0.0, 1.0) * last;
        let l = p.floor().min(last - 1.0);
        lo[c] = l as usize;
        f[c] = p - l;
    }
    let fx = f[0];
    let fy = f[1];
    let fz = f[2];

    let c000 = node(data, size, lo[0], lo[1], lo[2]);
    let c100 = node(data, size, lo[0] + 1, lo[1], lo[2]);
    let c010 = node(data, size, lo[0], lo[1] + 1, lo[2]);
    let c110 = node(data, size, lo[0] + 1, lo[1] + 1, lo[2]);
    let c001 = node(data, size, lo[0], lo[1], lo[2] + 1);
    let c101 = node(data, size, lo[0] + 1, lo[1], lo[2] + 1);
    let c011 = node(data, size, lo[0], lo[1] + 1, lo[2] + 1);
    let c111 = node(data, size, lo[0] + 1, lo[1] + 1, lo[2] + 1);

    let mut out = [0f32; 3];
    for c in 0..3 {
        out[c] = if fx >= fy {
            if fy >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fy) + c110[c] * (fy - fz) + c111[c] * fz
            } else if fx >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fz) + c101[c] * (fz - fy) + c111[c] * fy
            } else {
                c000[c] * (1.0 - fz) + c001[c] * (fz - fx) + c101[c] * (fx - fy) + c111[c] * fy
            }
        } else if fx >= fz {
            c000[c] * (1.0 - fy) + c010[c] * (fy - fx) + c110[c] * (fx - fz) + c111[c] * fz
        } else if fy >= fz {
            c000[c] * (1.0 - fy) + c010[c] * (fy - fz) + c011[c] * (fz - fx) + c111[c] * fx
        } else {
            c000[c] * (1.0 - fz) + c001[c] * (fz - fy) + c011[c] * (fy - fx) + c111[c] * fx
        };
    }
    out
}

/// Apply a baked film-print LUT across an interleaved RGBA f32 buffer (alpha
/// untouched), blending toward the film result by `strength` (0..100
/// nominal). This is the CPU oracle — a line-for-line port of
/// `raw_core::stages::film_look::apply_pixel`. `strength <= 0.0` is a
/// bit-identical no-op, matching the Rust stage's short-circuit.
///
/// # Panics
/// Panics if `size < 2` or `data.len() != film_lut_flat_len(size)`.
pub fn apply_film_lut(buf: &mut [f32], data: &[f32], size: usize, strength: f32) {
    assert!(size >= 2, "film LUT size must be >= 2, got {size}");
    assert_eq!(
        data.len(),
        film_lut_flat_len(size),
        "film LUT flat length must be size^3 * 3 = {}",
        film_lut_flat_len(size)
    );
    if strength <= 0.0 {
        return;
    }
    let t = (strength / 100.0).clamp(0.0, 1.0);
    for px in buf.chunks_exact_mut(4) {
        let original = [px[0], px[1], px[2]];
        let s_lin = mul3(&M_REC2020_TO_SRGB, original);
        let enc = [
            srgb_gamma(s_lin[0]).clamp(0.0, 1.0),
            srgb_gamma(s_lin[1]).clamp(0.0, 1.0),
            srgb_gamma(s_lin[2]).clamp(0.0, 1.0),
        ];
        let f_enc = tetra_sample(data, size, enc);
        let f_lin = [
            srgb_degamma(f_enc[0]),
            srgb_degamma(f_enc[1]),
            srgb_degamma(f_enc[2]),
        ];
        let f_2020 = mul3(&M_SRGB_TO_REC2020, f_lin);
        px[0] = original[0] + (f_2020[0] - original[0]) * t;
        px[1] = original[1] + (f_2020[1] - original[1]) * t;
        px[2] = original[2] + (f_2020[2] - original[2]) * t;
        // px[3] (alpha) untouched
    }
}

/// `repr(C)` params uniform shared by the WGSL kernel (`film_lut.wgsl`).
/// `count` is the RGBA pixel count; `size` is the LUT node count per axis;
/// `strength` is the ALREADY-CLAMPED blend factor `t = clamp(strength/100,
/// 0, 1)` — precomputed CPU-side (mirrors `grain`'s `grain_params` hoist) so
/// the kernel does one multiply-add, not a divide+clamp per pixel; `_pad`
/// rounds to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    size: u32,
    strength: f32,
    _pad: u32,
}

/// A GPU-resident film-look stage. Carries the flat film-LUT grid, its node
/// count, and the strength slider (0..100 nominal). Uploads the grid to
/// storage binding 3 and `count` / `size` / the clamped `t` to uniform
/// binding 0 inside `encode`.
pub struct FilmLutPass<'a> {
    /// Node count per axis (`N`); the grid is `N`³ RGB.
    pub size: u32,
    /// Blend strength, 0..100 nominal (clamped internally).
    pub strength: f32,
    /// Flat film-print grid (`size`³ × 3 floats, layout `((b*N+g)*N+r)*3+c`).
    pub data: std::borrow::Cow<'a, [f32]>,
}

impl Pass for FilmLutPass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        assert!(
            self.size >= 2,
            "film LUT size must be >= 2, got {}",
            self.size
        );
        assert_eq!(
            self.data.len(),
            film_lut_flat_len(self.size as usize),
            "film LUT flat length must be size^3 * 3 = {}",
            film_lut_flat_len(self.size as usize)
        );
        let (width, height) = dims;
        let pixel_count = width * height;
        let t = (self.strength / 100.0).clamp(0.0, 1.0);

        let params = Params {
            count: pixel_count,
            size: self.size,
            strength: t,
            _pad: 0,
        };
        // Per-look grid in a READ-ONLY STORAGE buffer (4-byte stride) — same
        // trap-avoidance as residual_lut / auto_profile_curve: a uniform
        // `array<f32>` would get a 16-byte per-element stride and silently
        // misalign. POOLED: a same-signature re-render (same film look, same
        // strength-crossing bucket) reuses the cached buffer.
        let lut_buf = pool_data_storage(ctx, bytemuck::cast_slice(&self.data), "film-lut-grid");

        // Pooled 4-binding dispatch: params @0, src @1, dst @2, grid @3.
        encode_simple(
            ctx,
            encoder,
            ctx.film_lut_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, lut_buf.as_ref()],
            pixel_count,
            "film-lut",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors residual_lut's / grain's tests.rs split). Native test
// builds only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "film_lut/tests.rs"]
mod tests;
