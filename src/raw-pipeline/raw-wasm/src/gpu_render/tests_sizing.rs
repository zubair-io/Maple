//! #1080 viewport-sized develop gates, split from `gpu_render/tests.rs` for the
//! 600-LOC file budget. The GPU live path develops FIT TO the caller's viewport
//! target instead of full sensor res (full res on a 100 MP frame exceeds the
//! downlevel 2048 texture baseline AND burns ~2.8 GB of transient f32 in wasm32's
//! permanently-grown heap). These pin: the no-target default, the cap actually
//! shrinking the develop, and the "cap ≥ source ⇒ bit-identical to the pre-#1080
//! full-res develop" no-op claim.
//!
//! Shares the sibling `tests` module's fixture/GPU/reference helpers
//! (`synthetic_dng_path` / `gpu_available` / `cpu_reference` — `pub(super)`
//! there). Same skip-pass pattern: fixture- and GPU-gated cases soft-pass when
//! the synthetic DNG or a Metal adapter is absent.

use super::tests::{cpu_reference, gpu_available, synthetic_dng_path};

use raw_core::pipeline::RenderQuality;
use raw_core::xmp::AdjustmentModel;

/// `normalize_target_long_edge`: `None` (the legacy no-arg JS call) and `0` (a
/// degenerate viewport measurement) both fall back to the 2048 default; explicit
/// values pass through. Pure — no GPU, no fixture, runs everywhere.
#[test]
fn target_long_edge_normalizes_none_and_zero_to_default() {
    assert_eq!(
        super::normalize_target_long_edge(None),
        super::DEFAULT_TARGET_LONG_EDGE
    );
    assert_eq!(
        super::normalize_target_long_edge(Some(0)),
        super::DEFAULT_TARGET_LONG_EDGE
    );
    assert_eq!(super::normalize_target_long_edge(Some(1)), 1);
    assert_eq!(super::normalize_target_long_edge(Some(1234)), 1234);
    assert_eq!(super::normalize_target_long_edge(Some(u32::MAX)), u32::MAX);
}

/// `effective_target_long_edge` clamps the normalized request to the device's
/// `max_texture_dimension_2d`. The context requests adapter-clamped limits
/// (#1079 — the downlevel 2048 baseline raised to the adapter's real cap), so
/// the clamp follows what THIS device actually accepts. GPU-gated: needs a real
/// device to read limits from.
#[test]
fn effective_target_long_edge_clamps_to_device_texture_cap() {
    use raw_gpu::GpuContext;
    if !gpu_available() {
        eprintln!("effective_target_long_edge: no GPU adapter — skipping (soft pass)");
        return;
    }
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let cap = ctx.device.limits().max_texture_dimension_2d;
    assert!(cap >= 1, "device texture cap must be positive");
    // Under the cap → passes through.
    assert_eq!(super::effective_target_long_edge(Some(16), &ctx), 16);
    // Over the cap → clamped to the cap.
    assert_eq!(
        super::effective_target_long_edge(Some(cap.saturating_mul(4)), &ctx),
        cap
    );
    // No target → the 2048 default, itself clamped (the adapter-clamped device
    // cap is ≥ the downlevel baseline, so this is == 2048 on real hardware).
    assert_eq!(
        super::effective_target_long_edge(None, &ctx),
        super::DEFAULT_TARGET_LONG_EDGE.min(cap)
    );
}

/// The sized develop actually SHRINKS the buffer: a 16-px cap on the 64×64
/// fixture develops to 16×16 with an exactly-sized RGBA pack. Fixture-gated,
/// no GPU needed (the develop + pack are pure CPU).
#[test]
fn develop_prefix_rgba_caps_long_edge() {
    let Some(path) = synthetic_dng_path() else {
        eprintln!("develop_prefix_rgba cap: synthetic DNG fixture absent — skipping (soft pass)");
        return;
    };
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");
    let model = AdjustmentModel::default();

    let (rgba, w, h, _prefix) =
        super::develop_prefix_rgba(&raw_img, &bytes, ext, &model, 16).expect("sized develop");
    assert_eq!(
        (w, h),
        (16, 16),
        "64×64 fixture capped at 16 must develop to 16×16"
    );
    assert_eq!(
        rgba.len(),
        (w * h * 4) as usize,
        "RGBA pack must be exactly w*h*4 lanes"
    );
    // Alpha lane pinned to 1.0 — the LiveSession upload shape.
    assert!(
        rgba.chunks_exact(4).all(|p| p[3] == 1.0),
        "alpha lane must be 1.0"
    );
}

/// THE NO-OP CLAIM: a cap at/above the source long edge is bit-identical to the
/// pre-#1080 full-res develop (raw-core's `downsample_image_area` early-returns;
/// the sized chain runs the same stage math under `sized_*` labels). This is what
/// keeps the W1 parity gate above meaningful and the small-image path unchanged.
/// Fixture-gated, no GPU needed.
#[test]
fn develop_prefix_rgba_uncapped_matches_unsized_develop() {
    use raw_core::pipeline::develop_scene_linear_from_raw_with_quality;

    let Some(path) = synthetic_dng_path() else {
        eprintln!("develop_prefix_rgba no-op: synthetic DNG fixture absent — skipping (soft pass)");
        return;
    };
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");
    let model = AdjustmentModel::default();

    let (rgba, w, h, prefix) = super::develop_prefix_rgba(
        &raw_img,
        &bytes,
        ext,
        &model,
        super::DEFAULT_TARGET_LONG_EDGE,
    )
    .expect("sized develop");

    // The pre-#1080 reference: the UNSIZED develop of the same stripped prefix,
    // packed the same way.
    let scene = develop_scene_linear_from_raw_with_quality(&raw_img, &prefix, RenderQuality::Full)
        .expect("unsized develop");
    assert_eq!(
        (w, h),
        (scene.width, scene.height),
        "cap ≥ source must not change dims"
    );
    let mut reference: Vec<f32> = Vec::with_capacity(scene.pixels.len() * 4);
    for p in &scene.pixels {
        reference.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }
    assert_eq!(
        rgba, reference,
        "cap ≥ source long edge must be BIT-IDENTICAL to the unsized develop"
    );
}

/// End-to-end sized render through the GPU chain: a 16-px cap returns a 16×16
/// surface whose per-channel means match the CPU full-res render's (the fixture
/// is a flat grey field — area-downsampling it is value-preserving, so a sizing
/// bug that double-applies gain or skips a stage shifts the means wholesale).
/// Fixture + GPU gated.
#[test]
fn render_gpu_core_sized_caps_dims_and_preserves_flat_field() {
    let Some(path) = synthetic_dng_path() else {
        eprintln!("render_gpu_core sized: synthetic DNG fixture absent — skipping (soft pass)");
        return;
    };
    if !gpu_available() {
        eprintln!("render_gpu_core sized: no GPU adapter — skipping (soft pass)");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");
    let model = AdjustmentModel::default();

    let (gw, gh, gpu) = pollster::block_on(super::render_gpu_core(
        &raw_img,
        &bytes,
        ext,
        &model,
        Some(16),
    ))
    .expect("sized GPU core render failed");
    assert_eq!(
        (gw, gh),
        (16, 16),
        "sized GPU render must adopt the capped dims"
    );
    assert_eq!(gpu.len(), (gw * gh * 3) as usize);

    let (_, _, cpu) = cpu_reference(&raw_img, &bytes, ext, &model);
    let mean = |buf: &[u8], ch: usize| -> f64 {
        let mut sum = 0u64;
        let mut n = 0u64;
        for px in buf.chunks_exact(3) {
            sum += px[ch] as u64;
            n += 1;
        }
        sum as f64 / n.max(1) as f64
    };
    for ch in 0..3 {
        let (m_gpu, m_cpu) = (mean(&gpu, ch), mean(&cpu, ch));
        let delta = (m_gpu - m_cpu).abs();
        eprintln!(
            "sized flat-field channel {ch}: GPU mean {m_gpu:.3} vs CPU mean {m_cpu:.3} (Δ {delta:.3})"
        );
        assert!(
            delta <= 1.0,
            "channel {ch} mean shifted {delta:.3} (> 1 LSB) between the sized GPU render and the \
             CPU full-res render of a FLAT field — the sized path altered the color math"
        );
    }
}
