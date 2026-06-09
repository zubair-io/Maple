//! Parity gate for the on-GPU airlight reduction (epic #925 P4b / #1033).
//!
//! The contract is NOT bit-exactness — `compute_airlight` selects the top-0.1%
//! darkest-channel pixels with a SORT (whose tie-break order is undefined across
//! GPU threads), and this module selects them with a PERCENTILE THRESHOLD over a
//! dark-channel histogram. The two agree to a documented TOLERANCE; this file
//! states and gates it.
//!
//! ## Why the histogram-percentile A is close-but-not-bit-exact to the sort
//!
//! 1. BOUNDARY-BIN INCLUSION. `compute_airlight` averages EXACTLY `top_n`
//!    pixels. The threshold scan stops at the first bin whose cumulative
//!    (from-the-top) count reaches `top_n`, then averages every pixel in bins at
//!    or above it — i.e. `top_n` pixels PLUS however many ties share the boundary
//!    bin. With 1024 bins (~1e-3 wide) over a realistic frame, the boundary bin
//!    holds only a handful of pixels, and they all sit within ~1e-3 of the true
//!    dark-channel cutoff — so they're drawn from the SAME bright haze region and
//!    shift A by a small amount.
//! 2. FLOAT SUMMATION ORDER. The masked average is a workgroup tree-reduction of
//!    f32 partials; raw-core sums sequentially. Same non-negative terms, different
//!    order → a ~1e-6 effect.
//!
//! ## The fixture (load-bearing) — a GENUINE top-0.1% average, not a degenerate tie
//!
//! The gate uses the 128×128 `top_n = 16` HAZY fixture (`hazy_image`, the same
//! construction `dehaze/tests.rs` uses): a hazy diagonal gradient whose
//! dark-channel values are DISTINCT, so the top-16 cut is unambiguous and the
//! percentile threshold lands on essentially the same 16 pixels the sort picks.
//!
//! It deliberately does NOT use the full-chain oracle's `scene_linear_rgba`:
//! that image scatters saturated primaries (min(r,g,b) = 0.1) every 11 px, so
//! EVERY 15×15 window contains one and the dark channel is the CONSTANT 0.1
//! everywhere. With a flat dark channel "top 0.1%" is a 16384-way TIE — the CPU
//! `sort_unstable` returns an arbitrary 16 (an artefact of its tie-break) and the
//! histogram threshold returns the whole-image average; the two diverge by ~0.5,
//! but NEITHER is "the airlight" (the dark-channel prior is meaningless on a flat
//! dc). That degeneracy is a property of that synthetic image, not of the
//! reduction — so it is the wrong fixture for an airlight gate. (The end-to-end
//! live-chain dehaze parity ON `scene_linear_rgba` is gated against the CPU
//! READBACK path in `live_session/tests.rs`, where both sides share the identical
//! `compute_airlight`; the on-GPU path's end-to-end dehaze parity is gated on the
//! hazy fixture there.)
//!
//! ## The gate
//!
//! On the hazy fixture the GPU airlight matches `compute_airlight` within
//! `AIRLIGHT_TOL` per channel. We ISOLATE the reduction from the dark-channel
//! kernel: both sides consume the SAME CPU dark channel (a local faithful copy,
//! pinned to raw-core's via `compute_airlight`), so a delta is attributable to the
//! reduction METHOD (threshold vs sort), not a dark-channel divergence (already
//! gated in `dehaze/tests.rs`).

use super::*;
use crate::compute_airlight;
use crate::image::GpuImage;
use crate::spatial::alloc_plane;
use crate::GpuContext;

/// Per-channel airlight tolerance vs `compute_airlight` (#1033). Measured on the
/// 128×128 `top_n = 16` fixture below (the test prints the actual deltas); set
/// roughly an order of magnitude above the observed worst channel so genuine
/// regressions trip it but boundary-bin / summation-order noise does not. The
/// dark channel is min(r,g,b) of scene-linear values, so A is O(1) — this is an
/// ABSOLUTE tolerance in scene-linear units.
const AIRLIGHT_TOL: f32 = 5e-3;

const DARK_RADIUS: i32 = 7; // 15×15 — raw-core's DARK_RADIUS / the dehaze min window.

/// A faithful clamp-to-edge 15×15 dark channel (own copy — `dehaze`'s is private,
/// and keeping a separate one means the test doesn't just re-run the code under
/// test). Pinned to raw-core's via `gpu_vs_cpu_reduction_*` (the CPU sort+avg over
/// THIS dc must equal `compute_airlight`).
fn dark_channel(pixels: &[[f32; 3]], w: usize, h: usize) -> Vec<f32> {
    let (wi, hi) = (w as i32, h as i32);
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    m = m.min(p[0].min(p[1]).min(p[2]));
                }
            }
            out[(y * wi + x) as usize] = m;
        }
    }
    out
}

/// The CPU reference reduction: raw-core's sort + top-N average over a GIVEN dark
/// channel (so the GPU and this share the exact same dc). Mirrors
/// `dehaze::atmospheric_light`.
fn cpu_topn_average(pixels: &[[f32; 3]], dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_unstable_by(|&a, &b| dc[b].partial_cmp(&dc[a]).unwrap_or(std::cmp::Ordering::Equal));
    let mut sum = [0.0f32; 3];
    for &i in &idx[..top_n] {
        sum[0] += pixels[i][0];
        sum[1] += pixels[i][1];
        sum[2] += pixels[i][2];
    }
    let k = top_n as f32;
    [sum[0] / k, sum[1] / k, sum[2] / k]
}

/// Run the on-GPU airlight reduction over `orig` (interleaved RGBA f32) + a
/// pre-computed dark channel `dc`, returning A = `[r, g, b]`. Uploads `orig` and
/// `dc` to the GPU, encodes `encode_airlight`, and reads back the airlight vec4.
/// (`encode_airlight` runs OUTSIDE a pool frame here, so its scratch is plain
/// allocations — exactly the dormant-pool stage-unit-test path.)
fn gpu_airlight(ctx: &GpuContext, orig: &[f32], dc: &[f32], w: u32, h: u32) -> [f32; 3] {
    let count = w * h;
    let orig_img = GpuImage::upload(ctx, orig, w, h);

    // Upload the dark channel into a scalar plane (COPY_DST via the scratch usage).
    let dc_plane = alloc_plane(ctx, w, h, "airlight-test-dc");
    ctx.queue.write_buffer(&dc_plane, 0, bytemuck::cast_slice(dc));

    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("airlight-test-encoder"),
        });
    let a_out = encode_airlight(ctx, &mut encoder, &orig_img.buffer, &dc_plane, count);

    // Copy the airlight vec4 into a MAP_READ staging buffer and read it back.
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("airlight-test-readback"),
        size: AIRLIGHT_BYTE_LEN,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&a_out, 0, &readback, 0, AIRLIGHT_BYTE_LEN);
    ctx.queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(rx).unwrap().unwrap();
    let data = slice.get_mapped_range();
    let v: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    [v[0], v[1], v[2]]
}

fn to_rgb(buf: &[f32]) -> Vec<[f32; 3]> {
    buf.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect()
}

/// THE PARITY GATE: on-GPU airlight vs `compute_airlight` on the 128×128
/// `top_n = 16` HAZY fixture (genuine top-0.1% average), within `AIRLIGHT_TOL` per
/// channel. Three pins:
///   (1) the local dark channel matches raw-core's (the CPU sort+avg over it
///       equals `compute_airlight` to f32 round-off),
///   (2) the GPU reduction (histogram→threshold→masked-average) matches that CPU
///       sort+avg within the documented tolerance — isolating the reduction
///       METHOD from the dark-channel kernel (gated elsewhere),
///   (3) the selection is non-vacuous (A finite, drawn from the bright region).
#[test]
fn gpu_airlight_matches_compute_airlight_at_128px() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (128usize, 128usize);
    assert_eq!(
        (w * h / 1000).max(1),
        16,
        "fixture sanity: 128×128 must give top_n = 16 (a real top-0.1% average, not an argmax)"
    );

    let input = hazy_image(w, h);
    let pixels = to_rgb(&input);
    let dc = dark_channel(&pixels, w, h);

    // Pin 1: the local dark channel's CPU sort+avg == raw-core's `compute_airlight`.
    let cpu_a = cpu_topn_average(&pixels, &dc);
    let rc_a = compute_airlight(&input, w, h);
    for c in 0..3 {
        assert!(
            (cpu_a[c] - rc_a[c]).abs() < 1e-5,
            "ch{c}: local dc sort+avg {} vs compute_airlight {} diverge — the test's dark \
             channel is not raw-core's (the reduction comparison would be confounded)",
            cpu_a[c],
            rc_a[c]
        );
    }

    // Pin 2: the GPU histogram-percentile reduction vs the CPU sort+avg (same dc).
    let gpu_a = gpu_airlight(&ctx, &input, &dc, w as u32, h as u32);
    let worst = (0..3)
        .map(|c| (gpu_a[c] - cpu_a[c]).abs())
        .fold(0.0f32, f32::max);
    eprintln!(
        "AIRLIGHT PARITY [hazy 128×128, top_n=16]: GPU A = {gpu_a:?}, CPU A = {cpu_a:?}, \
         worst channel delta = {worst:e} (tol {AIRLIGHT_TOL:e})"
    );

    // Pin 3: non-vacuous (A is drawn from the bright haze region, ~[0.67,0.63,0.58]).
    assert!(gpu_a.iter().all(|v| v.is_finite()), "GPU airlight must be finite, got {gpu_a:?}");
    assert!(
        gpu_a.iter().any(|&v| v > 0.1),
        "GPU airlight {gpu_a:?} is ~black — the masked average selected nothing (vacuous)"
    );

    assert!(
        worst < AIRLIGHT_TOL,
        "on-GPU airlight {gpu_a:?} vs compute_airlight {cpu_a:?} worst channel delta {worst} \
         exceeds the documented tolerance {AIRLIGHT_TOL} — the histogram-percentile reduction \
         diverged beyond boundary-bin + summation-order noise"
    );
}

/// A SHARPER-cut variant: scale the hazy gradient so the top-0.1% dark-channel
/// values are even more distinct (steeper gradient), confirming the tolerance
/// holds when the boundary bin holds ~exactly `top_n` pixels (the boundary-bin
/// inclusion error → its floor). Guards against the `AIRLIGHT_TOL` being tuned to
/// one gradient slope.
#[test]
fn gpu_airlight_holds_on_steeper_gradient() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (128usize, 128usize);
    let mut input = hazy_image(w, h);
    // Steepen: push the brightest quartile higher so the top dc values separate.
    for px in input.chunks_exact_mut(4) {
        let m = px[0].min(px[1]).min(px[2]);
        if m > 0.55 {
            for c in 0..3 {
                px[c] = (px[c] * 1.15).min(2.0);
            }
        }
    }
    let pixels = to_rgb(&input);
    let dc = dark_channel(&pixels, w, h);

    let cpu_a = cpu_topn_average(&pixels, &dc);
    let gpu_a = gpu_airlight(&ctx, &input, &dc, w as u32, h as u32);
    let worst = (0..3)
        .map(|c| (gpu_a[c] - cpu_a[c]).abs())
        .fold(0.0f32, f32::max);
    eprintln!(
        "AIRLIGHT PARITY [steeper 128×128]: GPU A = {gpu_a:?}, CPU A = {cpu_a:?}, \
         worst channel delta = {worst:e} (tol {AIRLIGHT_TOL:e})"
    );
    assert!(gpu_a.iter().all(|v| v.is_finite()), "GPU airlight must be finite");
    assert!(
        worst < AIRLIGHT_TOL,
        "steeper-gradient on-GPU airlight {gpu_a:?} vs compute_airlight {cpu_a:?} worst delta \
         {worst} exceeds tolerance {AIRLIGHT_TOL}"
    );
}

/// The 128×128 hazy fixture (mirrors `dehaze/tests.rs::hazy_image`, which is
/// test-private to that module). A hazy diagonal-gradient base with distinct
/// dark-channel values (so the top-N cut is unambiguous), a darker
/// low-transmission block, border features, and a small bright specular patch.
fn hazy_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            let mut luma = 0.45 + 0.20 * (gx + gy) * 0.5;
            if (24..56).contains(&x) && (72..104).contains(&y) {
                luma *= 0.35;
            }
            if x < 3 || y < 3 {
                luma += 0.15;
            }
            if x >= w - 4 && y >= h - 4 {
                luma *= 0.4;
            }
            let i = (y * w + x) * 4;
            v[i] = (luma * 1.04).min(1.0);
            v[i + 1] = (luma * 0.98).min(1.0);
            v[i + 2] = (luma * 0.90).min(1.0);
            v[i + 3] = 1.0;
        }
    }
    for y in 8..20 {
        for x in (w - 20)..(w - 8) {
            let i = (y * w + x) * 4;
            v[i] = 0.97;
            v[i + 1] = 0.965;
            v[i + 2] = 0.96;
        }
    }
    v
}
