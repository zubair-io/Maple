//! Auto Profile residual 3D LUT — a P2 view-transform WGSL port (#925 / #990).
//!
//! Ports `raw_core::view::auto_profile::lut::ColorLut::sample` (#924): the
//! per-image residual RGB→RGB grid layered onto the Auto Profile cube, applied by
//! **trilinear** interpolation. The grid is PER-IMAGE RUNTIME DATA — fitted from
//! the embedded JPEG at open time (`fit_lut_from_*`), NOT a codegen constant — so
//! the flat grid rides a read-only storage buffer uploaded per pass. This is the
//! canonical "runtime 3D LUT in storage + trilinear sample" pattern the spatial /
//! P3 / P4 waves reuse (distinct from the tone-curve / WB / auto_profile family,
//! which upload CPU-derived per-image *coefficients* rather than a sampled LUT).
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_residual_lut`] — the CPU oracle: a line-for-line port of
//!    `ColorLut::sample` over a flat RGBA f32 buffer (alpha untouched), reading
//!    the grid in the same `((b*N+g)*N+r)*3+c` layout.
//! 2. [`ResidualLutPass`] — the GPU-resident [`Pass`]; carries the flat grid +
//!    its node count `size`. The kernel needs NO generated color matrices (pure
//!    trilinear lookup), so `residual_lut.wgsl` compiles standalone. Uploads the
//!    grid to storage binding 3 and the `count` / `size` to uniform binding 0.
//! 3. The headless parity test ([`mod tests`], in `residual_lut/tests.rs`) — GPU
//!    vs the real `ColorLut::apply` (via the test-only `raw-core` dev-dep)
//!    `< 1e-4` on a NON-identity fitted grid (so the trilinear interpolation runs
//!    off the identity diagonal — the identity LUT alone would be a false green),
//!    plus an identity-LUT passthrough and an alpha-passthrough guard.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

/// Number of floats in a `size`³ RGB grid: `size * size * size * 3`. Mirrors the
/// `ColorLut::data` length (`n*n*n*3`).
#[inline]
pub fn residual_lut_flat_len(size: usize) -> usize {
    size * size * size * 3
}

/// One grid node's RGB triplet at `(r, g, b)`. Mirrors `ColorLut::node`: manual
/// flat index, no bounds clamp (the caller caps `lo` at `last - 1`, so `lo + 1`
/// never exceeds `size - 1`).
#[inline]
fn node(data: &[f32], size: usize, r: usize, g: usize, b: usize) -> [f32; 3] {
    let i = ((b * size + g) * size + r) * 3;
    [data[i], data[i + 1], data[i + 2]]
}

/// Trilinear lookup of one RGB triplet (inputs clamped to `[0, 1]`). A
/// line-for-line port of `ColorLut::sample` — same `lo`/`f` derivation (with the
/// `min(_, last - 1)` top-cell guard so an input of exactly 1.0 lands in the top
/// cell with `f = 1.0`) and the same r→g→b corner-blend nesting per channel.
fn sample(data: &[f32], size: usize, rgb: [f32; 3]) -> [f32; 3] {
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

    let mut out = [0.0f32; 3];
    let c000 = node(data, size, lo[0], lo[1], lo[2]);
    let c100 = node(data, size, lo[0] + 1, lo[1], lo[2]);
    let c010 = node(data, size, lo[0], lo[1] + 1, lo[2]);
    let c110 = node(data, size, lo[0] + 1, lo[1] + 1, lo[2]);
    let c001 = node(data, size, lo[0], lo[1], lo[2] + 1);
    let c101 = node(data, size, lo[0] + 1, lo[1], lo[2] + 1);
    let c011 = node(data, size, lo[0], lo[1] + 1, lo[2] + 1);
    let c111 = node(data, size, lo[0] + 1, lo[1] + 1, lo[2] + 1);

    for c in 0..3 {
        out[c] = if fx >= fy {
            if fy >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fy) + c110[c] * (fy - fz) + c111[c] * fz
            } else if fx >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fz) + c101[c] * (fz - fy) + c111[c] * fy
            } else {
                c000[c] * (1.0 - fz) + c001[c] * (fz - fx) + c101[c] * (fx - fy) + c111[c] * fy
            }
        } else {
            if fx >= fz {
                c000[c] * (1.0 - fy) + c010[c] * (fy - fx) + c110[c] * (fx - fz) + c111[c] * fz
            } else if fy >= fz {
                c000[c] * (1.0 - fy) + c010[c] * (fy - fz) + c011[c] * (fz - fx) + c111[c] * fx
            } else {
                c000[c] * (1.0 - fz) + c001[c] * (fz - fy) + c011[c] * (fy - fx) + c111[c] * fx
            }
        };
    }
    out
}

/// Apply a residual 3D LUT across an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a line-for-line port of
/// `raw_core::view::auto_profile::lut::ColorLut::sample`/`apply` (which operates
/// on packed RGB; here the RGB lanes of each RGBA pixel are transformed
/// identically and the alpha lane is carried through). `data` is the flat grid
/// (`size`³ × 3 floats, layout `((b*N+g)*N+r)*3+c`).
///
/// # Panics
/// Panics if `size < 2` or `data.len() != residual_lut_flat_len(size)`.
pub fn apply_residual_lut(buf: &mut [f32], data: &[f32], size: usize) {
    assert!(size >= 2, "residual LUT size must be >= 2, got {size}");
    assert_eq!(
        data.len(),
        residual_lut_flat_len(size),
        "residual LUT flat length must be size^3 * 3 = {}",
        residual_lut_flat_len(size)
    );
    for px in buf.chunks_exact_mut(4) {
        let out = sample(data, size, [px[0], px[1], px[2]]);
        px[0] = out[0];
        px[1] = out[1];
        px[2] = out[2];
        // px[3] (alpha) untouched
    }
}

/// `repr(C)` params uniform shared by the WGSL kernel (`residual_lut.wgsl`).
/// `count` is the RGBA pixel count; `size` is the LUT node count per axis;
/// `_pad*` round to 16 bytes. (`params`, not `meta` — `meta` is a reserved WGSL
/// keyword.)
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    size: u32,
    _pad0: u32,
    _pad1: u32,
}

/// A GPU-resident Auto Profile residual-LUT stage. Carries the per-image flat
/// grid + its node count `size` (`data.len()` must be `size`³ × 3). Uploads the
/// grid to storage binding 3 and the `count` / `size` to uniform binding 0 inside
/// `encode`.
pub struct ResidualLutPass {
    /// Node count per axis (`N`); the grid is `N`³ RGB.
    pub size: usize,
    /// Flat residual grid (`size`³ × 3 floats, layout `((b*N+g)*N+r)*3+c`).
    pub data: Vec<f32>,
}

impl Pass for ResidualLutPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        assert!(self.size >= 2, "residual LUT size must be >= 2, got {}", self.size);
        assert_eq!(
            self.data.len(),
            residual_lut_flat_len(self.size),
            "residual LUT flat length must be size^3 * 3 = {}",
            residual_lut_flat_len(self.size)
        );
        let (width, height) = dims;
        let pixel_count = width * height;

        let params = Params {
            count: pixel_count,
            size: self.size as u32,
            _pad0: 0,
            _pad1: 0,
        };
        // Per-image grid in a READ-ONLY STORAGE buffer (4-byte stride). A uniform
        // `array<f32>` would get a 16-byte per-element stride and silently
        // misalign — same trap auto_profile_curve's flat-curve buffer dodges.
        // POOLED (P4b-core C3): the grid is session-constant, so on a same-
        // signature re-render the cached buffer is reused — NOT re-uploaded.
        let lut_buf = pool_data_storage(ctx, bytemuck::cast_slice(&self.data), "residual-lut-grid");

        // Pooled 4-binding dispatch: params @0, src @1, dst @2, grid @3.
        encode_simple(
            ctx,
            encoder,
            ctx.residual_lut_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, lut_buf.as_ref()],
            pixel_count,
            "residual-lut",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors auto_profile_curve's `tests.rs` split). Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "residual_lut/tests.rs"]
mod tests;
