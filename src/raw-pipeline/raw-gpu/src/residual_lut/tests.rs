//! Parity tests for the Auto Profile residual-LUT WGSL kernel (#925 / #990).
//!
//! Split out of `residual_lut.rs` for the 600-LOC budget. Included via
//! `#[path = "residual_lut/tests.rs"] mod tests;` so it reaches the parent's
//! private helpers through `super::*`.
//!
//! The headless GPU kernel is gated DIRECTLY against the real
//! `raw_core::view::auto_profile::lut::ColorLut::apply` (the ticket's parity
//! oracle), via the test-only `raw-core` dev-dep, at `< 1e-4` per channel. The
//! load-bearing case is a NON-identity fitted grid — the tetrahedral interpolation
//! must run off the identity diagonal, or it's a false green (an identity LUT
//! returns its input regardless of whether the corner blend is correct).

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::view::auto_profile::pairs::DisplayPair;

/// An RGBA test buffer spanning the LUT's `[0, 1]` domain and its interpolation
/// branches:
///   - shadow / midtone / highlight greys (interior cells, generic tetrahedral),
///   - off-diagonal colors with distinct per-channel values (so the r→g→b corner
///     blend can't agree by symmetry),
///   - exact node-aligned values + exact 1.0 (the `min(_, last-1)` top-cell guard),
///   - a slightly-negative + a >1 channel (the input clamp to `[0, 1]`).
fn lut_rgba() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.05, 0.08, 0.03, 1.0, // deep shadow
        0.20, 0.35, 0.15, 0.8, // shadow-mid, off-diagonal
        0.45, 0.50, 0.55, 1.0, // midtone, off-diagonal
        0.72, 0.65, 0.80, 0.6, // highlight-mid, off-diagonal
        0.50, 0.50, 0.50, 1.0, // mid grey (diagonal)
        1.00, 1.00, 1.00, 1.0, // exact white -> top-cell guard, f = 1.0
        0.00, 0.00, 0.00, 1.0, // exact black -> bottom cell, f = 0.0
        0.95, 0.10, 0.30, 1.0, // saturated, off-diagonal
        1.40, -0.05, 0.50, 0.9, // out-of-range -> input clamp to [0, 1]
        0.25, 0.75, 0.50, 0.5, // node-ish + off-diagonal
    ]
}

/// Run the REAL `ColorLut::apply` on the RGB lanes of `rgba`, returning a full
/// RGBA buffer (alpha carried through). THE reference — the actual raw-core LUT
/// apply, not a reimplementation.
fn raw_core_apply(rgba: &[f32], lut: &ColorLut) -> Vec<f32> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    lut.apply(&mut rgb);
    let mut out = Vec::with_capacity(rgba.len());
    for (i, px) in rgb.chunks_exact(3).enumerate() {
        out.extend_from_slice(&[px[0], px[1], px[2], rgba[i * 4 + 3]]);
    }
    out
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// A NON-identity fitted residual grid, built via the real
/// `fit_lut_from_pairs` (the same uniform-shift-pair pattern raw-core's own LUT
/// tests use). The pairs add a luma-dependent, channel-asymmetric shift along the
/// grey diagonal, so the fitted grid departs from identity across the volume and
/// the tetrahedral blend is genuinely exercised. Using the real fitter guarantees
/// the grid is a shape the production path actually produces.
fn fitted_residual_lut(size: usize) -> ColorLut {
    let pairs: Vec<DisplayPair> = (0..400)
        .map(|i| {
            let v = i as f32 / 399.0;
            // Channel-asymmetric, value-dependent residual: red lifted more in
            // shadows, blue pulled in highlights, green mildly warmed.
            DisplayPair {
                maple: [v, v, v],
                jpeg: [
                    (v + 0.12 * (1.0 - v)).clamp(0.0, 1.0),
                    (v + 0.04).clamp(0.0, 1.0),
                    (v - 0.10 * v).clamp(0.0, 1.0),
                ],
            }
        })
        .collect();
    raw_core::view::auto_profile::lut::fit_lut_from_pairs(&pairs, size, 1.0)
}

/// THE PARITY GATE (the ticket's contract): the WGSL residual-LUT kernel matches
/// the REAL `ColorLut::apply` within 1e-4 on a NON-identity fitted grid. This is
/// the non-vacuous tetrahedral-interpolation proof — the grid departs from identity
/// across the color volume, so the corner blend (not just a passthrough) is what
/// gets gated. Run at the production node count (49) and a small count (9) to
/// catch any `size`-uniform off-by-one.
#[test]
fn wgsl_residual_lut_matches_raw_core_apply_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = lut_rgba();
    let count = (input.len() / 4) as u32;

    for size in [9usize, 49usize] {
        let lut = fitted_residual_lut(size);
        assert_eq!(lut.size, size);
        // Sanity: the fitted grid is genuinely non-identity (else the gate would
        // be vacuous). Compare to the identity grid of the same size.
        let id = ColorLut::identity(size);
        let grid_dev = max_abs_diff(&lut.data, &id.data);
        assert!(
            grid_dev > 1e-3,
            "fitted grid (size {size}) is ~identity (max node dev {grid_dev}); gate would be vacuous"
        );

        let reference = raw_core_apply(&input, &lut);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ResidualLutPass {
            size,
            data: lut.data.clone(),
        }]);

        let max_diff = max_abs_diff(&reference, &gpu);
        eprintln!("PARITY vs raw-core ColorLut::apply (size {size}): max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[size {size}]: GPU vs raw-core ColorLut::apply max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_residual_lut`) to the real `ColorLut::apply`
/// too, so the convenience oracle this crate exports can't silently drift. Covers
/// the non-identity fitted grid. (The GPU gate above doesn't depend on the local
/// oracle.)
#[test]
fn local_oracle_matches_raw_core_apply_within_1e_4() {
    let input = lut_rgba();
    for size in [9usize, 49usize] {
        let lut = fitted_residual_lut(size);
        let reference = raw_core_apply(&input, &lut);
        let mut local = input.clone();
        apply_residual_lut(&mut local, &lut.data, size);
        let max_diff = max_abs_diff(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "[size {size}]: local oracle vs raw-core ColorLut::apply diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU oracle
/// within 1e-4 (no raw-core dep needed to run). Fast, dependency-free signal
/// alongside the raw-core gate; mirrors the vibrance / auto_profile_curve precedent.
#[test]
fn wgsl_residual_lut_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = lut_rgba();
    let count = (input.len() / 4) as u32;

    for size in [9usize, 49usize] {
        let lut = fitted_residual_lut(size);
        let mut cpu = input.clone();
        apply_residual_lut(&mut cpu, &lut.data, size);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ResidualLutPass {
            size,
            data: lut.data.clone(),
        }]);

        let max_diff = max_abs_diff(&cpu, &gpu);
        eprintln!("PARITY [size {size}]: GPU vs CPU oracle max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[size {size}]: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// >cap 2-D dispatch regression (#1881): with more than 65535 workgroups
/// `encode_simple` tiles the dispatch into a 2-D grid (`gy > 1`). The buggy
/// 1-D index (`gid.x` alone) addressed only the first 65535*64 pixels and
/// left every later pixel UNWRITTEN in the output ping-pong buffer — on a
/// 2880x2160 GPU-live preview under profile=auto that painted a hard tone
/// seam at row ~1456 and got persisted into the rendered-preview cache. The
/// fixed index (`gid.y * ng.x * 64u + gid.x`) reaches every pixel. Uses a
/// 2176x2176-equivalent buffer (4,734,976 px → 73,984 groups → gx=65535,
/// gy=2) so the high-index tile is exercised; on small buffers the old and
/// new indices coincide and the other parity tests pass regardless.
#[test]
fn wgsl_residual_lut_matches_cpu_oracle_above_dispatch_cap() {
    let pixel_count: usize = 2176 * 2176;
    let groups = (pixel_count as u32).div_ceil(64);
    let gx = groups.min(65535);
    let gy = groups.div_ceil(gx);
    assert!(groups > 65535, "buffer must exceed the 65535-group 1-D cap");
    assert!(
        gy > 1,
        "dispatch must tile into 2-D (gy>1), got gy={gy}, gx={gx}"
    );

    let ctx = GpuContext::new_blocking().expect("gpu context");
    // Fill the buffer with a repeating spread of the branch-covering probe
    // pixels so the high-index tile sees the same interpolation branches as
    // the low one.
    let probe = lut_rgba();
    let input: Vec<f32> = (0..pixel_count * 4)
        .map(|i| probe[i % probe.len()])
        .collect();

    let lut = fitted_residual_lut(49);
    let mut cpu = input.clone();
    apply_residual_lut(&mut cpu, &lut.data, lut.size);

    let img = GpuImage::upload(&ctx, &input, 2176, 2176);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ResidualLutPass {
        size: lut.size,
        data: lut.data.clone(),
    }]);

    // Track the worst diff AND its location so a regression that only misses
    // the gy==1 tile (high pixel indices) is unmistakable.
    let (max_diff, worst_idx) = cpu
        .iter()
        .zip(&gpu)
        .enumerate()
        .map(|(idx, (a, b))| ((a - b).abs(), idx))
        .fold(
            (0.0_f32, 0usize),
            |(m, mi), (d, idx)| {
                if d > m {
                    (d, idx)
                } else {
                    (m, mi)
                }
            },
        );
    eprintln!(
        ">CAP PARITY pixels={pixel_count} gx={gx} gy={gy}: \
         max abs diff = {max_diff:e} at flat idx {worst_idx} (px {})",
        worst_idx / 4
    );
    assert!(
        max_diff < 1e-4,
        "above-cap GPU vs CPU max abs diff {max_diff} exceeds 1e-4 (worst at px {})",
        worst_idx / 4
    );
}

/// An identity LUT is a near-passthrough on the GPU within `[0, 1]` (where each
/// tetrahedral sample of the identity grid reproduces its input). Guards against an
/// index-order bug in `((b*N+g)*N+r)` that would skew even a true identity grid.
#[test]
fn identity_lut_is_near_passthrough_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = lut_rgba();
    let count = (input.len() / 4) as u32;
    let size = 17usize;
    let id = ColorLut::identity(size);

    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ResidualLutPass {
        size,
        data: id.data.clone(),
    }]);

    // Compare only the in-range RGB lanes against the clamped input (an identity
    // LUT clamps its output to [0, 1] by construction of the identity grid).
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        for c in 0..3 {
            let expected = chunk[c].clamp(0.0, 1.0);
            let got = gpu[i * 4 + c];
            assert!(
                (got - expected).abs() < 1e-4,
                "identity LUT not passthrough at px {i} chan {c}: {got} vs {expected}"
            );
        }
    }
}

/// Alpha is carried through untouched by the GPU kernel (the residual LUT touches
/// only RGB). Mirrors the per-stage alpha-passthrough contract.
#[test]
fn gpu_alpha_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = lut_rgba();
    let count = (input.len() / 4) as u32;
    let lut = fitted_residual_lut(49);
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ResidualLutPass {
        size: lut.size,
        data: lut.data.clone(),
    }]);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        assert_eq!(
            gpu[i * 4 + 3],
            chunk[3],
            "alpha changed at pixel {i}: {} -> {}",
            chunk[3],
            gpu[i * 4 + 3]
        );
    }
}
