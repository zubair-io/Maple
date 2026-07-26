//! Headless parity tests for the NLM noise-reduction SPATIAL stage (epic #925 P3
//! wave 1 / #991). Two independent error sources are gated SEPARATELY:
//!
//! 1. **Plane-level** — the GPU NLM core (`encode_nlm_on_plane`) vs the REAL
//!    `raw_core::stages::nlm::denoise_plane` on a raw f32 plane, NO Oklab. This
//!    isolates the NLM math (direct patch-SSD + the `fast_neg_exp` lerp) from the
//!    color round-trip, so a `< 1e-4` here proves the kernel itself is faithful.
//! 2. **Stage-level** — the full `NlmLumaPass` / `NlmColorPass` (extract → NLM →
//!    writeback) vs `raw_core::stages::noise_reduction::{apply_luminance,apply_color}`
//!    on RGBA. The remaining diff over the plane gate is purely the Oklab
//!    transforms (the same ~1e-6 clarity / vibrance already absorb).
//!
//! ## Test-image design (why MODEST content keeps the gate honest)
//!
//! raw-core is the integral-image side: its f32 rect query
//! (`ii_bot[x1]-ii_top[x1]-ii_bot[x0]+ii_top[x0]`) carries cumulative-sum
//! CANCELLATION error our direct patch-sum doesn't reproduce. On a pathological
//! image (hard edges, large cumulative sums) raw-core becomes the noisy side and
//! we'd diverge through no GPU fault. So the fixtures use a gentle gradient + a
//! few localized features — keeping neighbour sqdiff tiny (so raw-core's integral
//! sums stay O(1–10) and cancellation stays well under 1e-4), while still
//! exercising the patch-radius border strip, interior FULL windows, and a real
//! spread of patch SSDs (so the exp weighting is non-vacuous).

use super::*;
use crate::chain::{read_buffer_async, ChainRunner};
use crate::context::GpuContext;
use crate::image::GpuImage;
use wgpu::util::DeviceExt;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A modest `w×h` scalar plane: a gentle diagonal gradient (small slope, so
/// neighbour differences are tiny) plus deterministic low-amplitude texture and a
/// couple of localized features hugging the borders. Values land in ~[0, ~0.3] —
/// the Oklab L / a / b range NLM operates in — and vary smoothly enough that
/// raw-core's integral sums stay small. Border + interior pixels both get real
/// (distinct) patch SSDs.
fn modest_plane(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            // Gentle gradient base (slope ~0.1 across the frame).
            let mut val = 0.10 + 0.10 * (gx + gy) * 0.5;
            // Low-amplitude deterministic texture so patches differ (drives the
            // weight spread) without large jumps.
            val += 0.02 * ((x * 7 + y * 13) % 5) as f32 / 5.0;
            // A faint bright feature hugging the LEFT + TOP edges, and a faint
            // dark dip in the BOTTOM-RIGHT corner — exercise the border strip.
            if x < 3 || y < 3 {
                val += 0.04;
            }
            if x >= w - 4 && y >= h - 4 {
                val -= 0.03;
            }
            v[y * w + x] = val;
        }
    }
    v
}

/// A modest RGBA f32 image whose channels carry a gentle gradient + faint border
/// features + a small per-channel skew (so R:G:B is non-neutral and the Oklab a/b
/// planes carry real, low-amplitude chroma for the color NR gate). Values stay
/// well inside [0, 1].
pub(super) fn modest_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            let mut luma = 0.30 + 0.20 * (gx + gy) * 0.5;
            luma += 0.02 * ((x * 7 + y * 13) % 5) as f32 / 5.0;
            if x < 3 || y < 3 {
                luma += 0.05;
            }
            if x >= w - 4 && y >= h - 4 {
                luma -= 0.04;
            }
            let i = (y * w + x) * 4;
            // Per-channel skew that itself wobbles a touch with position so the
            // a/b planes aren't flat (color NR has something to denoise).
            let skew = 0.03 * ((x + y) % 3) as f32;
            v[i] = (luma * 1.06 + skew).clamp(0.0, 1.0);
            v[i + 1] = (luma * 0.98).clamp(0.0, 1.0);
            v[i + 2] = (luma * 0.88 + skew * 0.5).clamp(0.0, 1.0);
            v[i + 3] = 1.0;
        }
    }
    v
}

// ── Pass constructors ─────────────────────────────────────────────────────────

/// A luma-NR pass with NO DNG NoiseProfile — the flat, un-modulated filter these
/// gates cover, matching the `None` the raw-core references are called with. The
/// per-pixel-modulated case is gated in the sibling `tests_profile.rs` (#1714).
pub(super) fn luma_pass(amount: f32) -> NlmLumaPass {
    NlmLumaPass {
        nr_luminance: amount,
        noise_profile: Vec::new(),
        iso: 100,
    }
}

/// The color-NR sibling of [`luma_pass`].
pub(super) fn color_pass(amount: f32) -> NlmColorPass {
    NlmColorPass {
        nr_color: amount,
        noise_profile: Vec::new(),
        iso: 100,
    }
}

// ── GPU drivers ────────────────────────────────────────────────────────────────

/// Run the GPU NLM core on a raw f32 plane (no Oklab): upload `plane`, encode
/// `encode_nlm_on_plane`, submit, read back. The plane-level parity driver.
pub(super) fn denoise_plane_gpu(
    ctx: &GpuContext,
    plane: &[f32],
    guide: &[f32],
    w: u32,
    h: u32,
    params: NlmParams,
    modulation: NoiseModulation,
) -> Vec<f32> {
    let upload = |data: &[f32], label: &str| {
        ctx.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
            })
    };
    let plane_buf = upload(plane, "nr-test-plane");
    let guide_buf = upload(guide, "nr-test-guide");
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("nr-test-encoder"),
        });
    // `guide` is raw-core's `l_plane` argument: the plane itself for luma NR, the
    // separate L plane for a chroma plane.
    let denoised = encode_nlm_on_plane(
        ctx,
        &mut encoder,
        &plane_buf,
        &guide_buf,
        w,
        h,
        params,
        modulation,
    );
    let byte_len = (w as u64) * (h as u64) * std::mem::size_of::<f32>() as u64;
    ctx.queue.submit(Some(encoder.finish()));
    pollster::block_on(read_buffer_async(ctx, &denoised, byte_len)).expect("readback")
}

/// `raw_core::stages::nlm::denoise_plane` on the same plane — the plane-level
/// reference. Translates our local `NlmParams` into raw-core's identical type.
fn raw_core_denoise_plane(plane: &[f32], w: usize, h: usize, params: NlmParams) -> Vec<f32> {
    let rc = raw_core::stages::nlm::NlmParams {
        patch_radius: params.patch_radius,
        search_radius: params.search_radius,
        h: params.h,
    };
    raw_core::stages::nlm::denoise_plane(plane, w, h, rc)
}

/// `raw_core::stages::noise_reduction::apply_luminance` on a flat RGBA buffer —
/// the stage-level reference for luma NR (alpha carried through untouched).
fn raw_core_nr_luma(buf: &[f32], w: u32, h: u32, amount: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::noise_reduction::apply_luminance(&mut img, amount, None, 100);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// `raw_core::stages::noise_reduction::apply_color` on a flat RGBA buffer — the
/// stage-level reference for color NR.
fn raw_core_nr_color(buf: &[f32], w: u32, h: u32, amount: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::noise_reduction::apply_color(&mut img, amount, None, 100);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Max abs diff between two flat buffers, plus the worst index.
pub(super) fn max_diff_at(a: &[f32], b: &[f32]) -> (f32, usize) {
    let mut worst = 0.0f32;
    let mut worst_i = 0usize;
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        let d = (x - y).abs();
        if d > worst {
            worst = d;
            worst_i = i;
        }
    }
    (worst, worst_i)
}

// ── Plane-level parity (NLM math in isolation, no Oklab) ───────────────────────

/// THE PRIMARY KERNEL GATE: the GPU NLM core matches
/// `raw_core::stages::nlm::denoise_plane` `< 1e-4` on a raw plane, for the LUMA
/// params (P=2, S=2, h=LUMA_H_MAX). No Oklab — so this gate is purely the NLM
/// math (direct patch-SSD summation + the `fast_neg_exp` grid-lerp weight).
#[test]
fn nlm_core_matches_denoise_plane_luma_params() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let plane = modest_plane(w, h);
    let params = luma_params(100.0);
    let reference = raw_core_denoise_plane(&plane, w, h, params);
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(None, 100, false),
    );

    let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
    let (wx, wy) = (worst_i % w, worst_i / w);
    eprintln!(
        "PLANE PARITY (luma params): max abs diff = {max_diff:e} at ({wx},{wy}) \
         [border={}]",
        wx < 2 || wy < 2 || wx >= w - 2 || wy >= h - 2
    );
    assert!(
        max_diff < 1e-4,
        "GPU NLM core vs denoise_plane (luma) max abs diff {max_diff} exceeds 1e-4 \
         (worst at ({wx},{wy}))"
    );
}

/// Plane gate for the CHROMA params (wider search S=3) — confirms the larger
/// shift window is encoded faithfully (more shifts → more accumulation, the
/// regime most sensitive to weight error).
#[test]
fn nlm_core_matches_denoise_plane_chroma_params() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let plane = modest_plane(w, h);
    let params = chroma_params(100.0);
    let reference = raw_core_denoise_plane(&plane, w, h, params);
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(None, 100, false),
    );

    let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
    let (wx, wy) = (worst_i % w, worst_i / w);
    eprintln!("PLANE PARITY (chroma params): max abs diff = {max_diff:e} at ({wx},{wy})");
    assert!(
        max_diff < 1e-4,
        "GPU NLM core vs denoise_plane (chroma) max abs diff {max_diff} exceeds 1e-4 \
         (worst at ({wx},{wy}))"
    );
}

/// Plane gate at a HALF-strength slider (amount=50) — `h` differs, so this
/// confirms the `inv_norm` scaling is right at a non-maximal strength.
#[test]
fn nlm_core_matches_denoise_plane_half_strength() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (40usize, 40usize);
    let plane = modest_plane(w, h);
    let params = luma_params(50.0);
    let reference = raw_core_denoise_plane(&plane, w, h, params);
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(None, 100, false),
    );
    let (max_diff, _) = max_diff_at(&reference, &gpu);
    eprintln!("PLANE PARITY (amount=50): max abs diff = {max_diff:e}");
    assert!(
        max_diff < 1e-4,
        "amount=50 plane diff {max_diff} exceeds 1e-4"
    );
}

/// BORDER + INTERIOR coverage is non-vacuous: assert the patch-radius border
/// strip (passed through unchanged by raw-core) AND the interior (full windows,
/// actually denoised) BOTH match, and that the interior actually MOVED (so the
/// gate isn't trivially satisfied by an identity transform).
#[test]
fn nlm_core_border_and_interior_coverage_non_vacuous() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let p = LUMA_PATCH_RADIUS;
    let plane = modest_plane(w, h);
    let params = luma_params(100.0);
    let reference = raw_core_denoise_plane(&plane, w, h, params);
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(None, 100, false),
    );

    // Border strip: raw-core passes it through unchanged; GPU must agree AND
    // reproduce the original value (passthrough), within 1e-4.
    let mut border_worst = 0.0f32;
    let mut border_counted = 0usize;
    // Interior: must match the reference AND have actually changed from input
    // somewhere (denoising happened).
    let mut interior_worst = 0.0f32;
    let mut interior_counted = 0usize;
    let mut interior_moved = 0.0f32;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let in_strip = x < p || x >= w - p || y < p || y >= h - p;
            if in_strip {
                border_counted += 1;
                border_worst = border_worst.max((reference[i] - gpu[i]).abs());
                // Passthrough check: raw-core leaves border == input.
                assert!(
                    (reference[i] - plane[i]).abs() < 1e-6,
                    "reference border ({x},{y}) not passthrough — fixture/policy drift"
                );
            } else {
                interior_counted += 1;
                interior_worst = interior_worst.max((reference[i] - gpu[i]).abs());
                interior_moved = interior_moved.max((reference[i] - plane[i]).abs());
            }
        }
    }
    eprintln!(
        "BORDER strip: {border_counted} px, worst {border_worst:e}; \
         INTERIOR: {interior_counted} px, worst {interior_worst:e}, max move {interior_moved:e}"
    );
    assert!(
        border_counted > 0 && interior_counted > 0,
        "coverage vacuous"
    );
    assert!(
        interior_moved > 1e-4,
        "interior never moved ({interior_moved:e}) — denoising is a no-op, gate is vacuous"
    );
    assert!(
        border_worst < 1e-4,
        "border-strip diff {border_worst} exceeds 1e-4"
    );
    assert!(
        interior_worst < 1e-4,
        "interior diff {interior_worst} exceeds 1e-4"
    );
}

// ── Stage-level parity (full Pass: extract → NLM → writeback, with Oklab) ──────

/// THE LUMA STAGE GATE: `NlmLumaPass` matches
/// `raw_core::stages::noise_reduction::apply_luminance` `< 1e-4` across slider
/// values, on a modest RGBA image. Covers extract (RGBA→L), the NLM core, and
/// writeback (L restored, a/b recomputed) — the whole Oklab round-trip.
#[test]
fn nlm_luma_pass_matches_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = modest_image(w, h);
    for &amount in &[40.0_f32, 75.0, 100.0] {
        let reference = raw_core_nr_luma(&input, w as u32, h as u32, amount);
        // Non-vacuity: raw-core's luma-NR must actually move the image (else a
        // passthrough would satisfy the gate). The L plane mirrors modest_plane,
        // so this is comfortable, but assert it explicitly like the color test.
        let (moved, _) = max_diff_at(&input, &reference);
        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&luma_pass(amount)]);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "LUMA STAGE PARITY amount={amount}: max abs diff = {max_diff:e} at pixel ({},{}); \
             raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "luma-NR amount={amount} barely moved the image ({moved:e}) — gate is vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "NlmLumaPass vs apply_luminance amount={amount} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// THE COLOR STAGE GATE: `NlmColorPass` matches
/// `raw_core::stages::noise_reduction::apply_color` `< 1e-4`. Covers the wider
/// chroma search window, BOTH a and b denoised, L recomputed in writeback.
///
/// NON-VACUITY: the plane-level gates drive `encode_nlm_on_plane` on a raw
/// uploaded plane — they NEVER exercise `extract_channel(channel=A/B)` or
/// `writeback_color`, nor the chroma slider→params map. Those are covered ONLY
/// here, so this test must move the image meaningfully (else it'd pass whether
/// the GPU denoised a/b or passed them through). We assert raw-core's color-NR
/// shifts `input` by ≫ 1e-4 — mirroring the plane test's `interior_moved` guard.
#[test]
fn nlm_color_pass_matches_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = modest_image(w, h);
    for &amount in &[40.0_f32, 75.0, 100.0] {
        let reference = raw_core_nr_color(&input, w as u32, h as u32, amount);
        // raw-core actually moved the image — proves the a/b denoise path is
        // genuinely exercised, not vacuously matched by a passthrough.
        let (moved, _) = max_diff_at(&input, &reference);
        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&color_pass(amount)]);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "COLOR STAGE PARITY amount={amount}: max abs diff = {max_diff:e} at pixel ({},{}); \
             raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "color-NR amount={amount} barely moved the image ({moved:e}) — the a/b denoise \
             + writeback_color path is only vacuously gated; bump modest_image's chroma"
        );
        assert!(
            max_diff < 1e-4,
            "NlmColorPass vs apply_color amount={amount} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

// ── Identity / robustness ──────────────────────────────────────────────────────

/// `nr_luminance = 0` is identity: the GPU must reproduce the input bit-for-bit
/// (the Pass copies src → dst). Mirrors raw-core's `|amount| < 1e-3` early return.
#[test]
fn nlm_luma_zero_is_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = modest_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&luma_pass(0.0)]);
    assert_eq!(
        gpu, input,
        "nr_luminance=0 must pass the image through unchanged"
    );
}

/// `nr_color = 0` is identity (same contract as luma).
#[test]
fn nlm_color_zero_is_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = modest_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&color_pass(0.0)]);
    assert_eq!(
        gpu, input,
        "nr_color=0 must pass the image through unchanged"
    );
}

/// A flat neutral field has no patch differences, so every weight is `exp(0)=1`
/// and the output stays on the flat value (raw-core's `constant_plane_unchanged`
/// invariant carried through the Oklab round-trip). Confirms no NaN from the
/// neutral-axis Oklab path either.
#[test]
fn nlm_flat_field_stays_flat() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 32usize);
    let input: Vec<f32> = (0..w * h).flat_map(|_| [0.4f32, 0.4, 0.4, 1.0]).collect();
    let reference_l = raw_core_nr_luma(&input, w as u32, h as u32, 100.0);
    let reference_c = raw_core_nr_color(&input, w as u32, h as u32, 100.0);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu_l = runner.run_blocking(&[&luma_pass(100.0)]);
    let gpu_c = runner.run_blocking(&[&color_pass(100.0)]);
    assert!(
        gpu_l.iter().all(|v| v.is_finite()),
        "luma NR produced non-finite output"
    );
    assert!(
        gpu_c.iter().all(|v| v.is_finite()),
        "color NR produced non-finite output"
    );
    let (dl, _) = max_diff_at(&reference_l, &gpu_l);
    let (dc, _) = max_diff_at(&reference_c, &gpu_c);
    assert!(dl < 1e-4, "flat-field luma drifted from raw-core by {dl}");
    assert!(dc < 1e-4, "flat-field color drifted from raw-core by {dc}");
}

/// Composition: NLM behaves as ONE [`Pass`] in a multi-pass chain — exposure at
/// ev=0 is identity, so `[ExposurePass{0.0}, NlmLumaPass]` must equal
/// NlmLumaPass-alone; AND two NLM passes back-to-back finish without a resource /
/// validation error (the scratch planes a spatial pass allocates per `encode`
/// don't collide across encodes).
#[test]
fn nlm_composes_as_one_pass_in_a_chain() {
    use crate::exposure::ExposurePass;
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 32usize);
    let input = modest_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);

    let solo = runner.run_blocking(&[&luma_pass(80.0)]);
    let chained = runner.run_blocking(&[&ExposurePass { ev: 0.0 }, &luma_pass(80.0)]);
    let (diff, _) = max_diff_at(&solo, &chained);
    assert!(
        diff < 1e-4,
        "NLM after an identity exposure pass diverged from NLM-alone by {diff} \
         — the stage does not compose as a clean src→dst Pass"
    );

    let stacked = runner.run_blocking(&[&luma_pass(60.0), &color_pass(60.0)]);
    assert!(
        stacked.iter().all(|v| v.is_finite()),
        "luma-then-color NR produced non-finite output"
    );
}
