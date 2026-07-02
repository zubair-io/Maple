//! Tests for `pipeline::render`.
//!
//! Split out from `mod.rs` to keep each file under the 600-LOC budget
//! (#482). Exercises the public render entries — disk-backed fixture
//! renders (`ignore`d without `--features fixtures`; fail closed on a
//! missing fixture with it, #1082), the synthetic
//! `render_from_scene_linear` invariants, and the f32 / fp16 scene-linear
//! parity checks (#416, #482). Moved verbatim; the inner `mod tests {}`
//! wrapper becomes the file itself.

#![cfg(test)]

use super::*;
use crate::synthetic_input::{halo_disk, hue_patch, neutral_ramp, Primary};
use crate::test_support::fixtures::require_raw;

/// Shell helper for tests only — reads from disk then runs the pure
/// pipeline. The core no longer exposes a path-based entrypoint.
fn render_path(path: &std::path::Path, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    let bytes = std::fs::read(path).map_err(|e| crate::error::Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = crate::decode::decode_bytes(&bytes, ext)?;
    render_from_raw(&raw, model)
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_test_0002_baseline_produces_plausible_png_bytes() {
    let path = require_raw("test_0002.dng");
    let model = AdjustmentModel::default();
    let (w, h, bytes) = render_path(&path, &model).expect("render baseline");
    assert_eq!(bytes.len() as u32, w * h * 3);
    // Image is not all zeros and not all 255.
    let zero_ratio = bytes.iter().filter(|b| **b == 0).count() as f32 / bytes.len() as f32;
    let max_ratio = bytes.iter().filter(|b| **b == 255).count() as f32 / bytes.len() as f32;
    assert!(
        zero_ratio < 0.5,
        "too many zeros ({:.1}%)",
        zero_ratio * 100.0
    );
    assert!(
        max_ratio < 0.5,
        "too many saturated pixels ({:.1}%)",
        max_ratio * 100.0
    );
    eprintln!(
        "render: {}x{}, zero={:.1}%, max={:.1}%, mean={}",
        w,
        h,
        zero_ratio * 100.0,
        max_ratio * 100.0,
        bytes.iter().map(|&b| b as u64).sum::<u64>() / bytes.len() as u64
    );
}

/// Cross-format invariance for ProfileToneCurve on test_0013 (Apple
/// iPhone 12 Pro DNG). Under ticket #425 (colorimetry-only DCP), the
/// source DNG's PTC must be a no-op in the develop chain on EVERY
/// `ProfileSource` — Bundled, EmbeddedDng, and Generic. Pre-#425
/// the bundled path suppressed PTC and the non-bundled paths kept it,
/// producing per-format inconsistency; that branch is gone.
///
/// Verifies:
/// 1. RawImage carries the parsed PTC (decode-side wiring; unchanged).
/// 2. The pipeline renders cleanly with PTC present in the raw — no
///    panics, no NaN, plausible output statistics.
/// 3. Render WITH PTC == Render WITHOUT PTC, byte-for-byte, regardless
///    of which profile source is in play. The PTC field is dead data
///    in the develop chain.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_test_0013_ptc_is_noop_under_colorimetry_only() {
    let path = require_raw("test_0013.DNG");
    let bytes = std::fs::read(&path).unwrap();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode iPhone");
    assert!(
        raw.profile_tone_curve.is_some(),
        "test_0013 must surface a ProfileToneCurve (decode-side wiring)"
    );
    let model = AdjustmentModel::default();
    let (w, h, with_ptc) = render_from_raw(&raw, &model).expect("render with PTC");
    assert_eq!(with_ptc.len() as u32, w * h * 3);
    // Plausibility: not all zero, not all saturated.
    let zero_ratio = with_ptc.iter().filter(|b| **b == 0).count() as f32 / with_ptc.len() as f32;
    let sat_ratio = with_ptc.iter().filter(|b| **b == 255).count() as f32 / with_ptc.len() as f32;
    assert!(
        zero_ratio < 0.5,
        "render too dark: {:.1}% zeros",
        zero_ratio * 100.0
    );
    assert!(
        sat_ratio < 0.5,
        "render too bright: {:.1}% saturated",
        sat_ratio * 100.0
    );
    // Render WITHOUT PTC by stripping the field. Under #425 the two
    // renders must be bit-identical because the DCP path no longer
    // consumes `raw.profile_tone_curve` on any source.
    let mut raw_no_ptc = raw.clone();
    raw_no_ptc.profile_tone_curve = None;
    let (_, _, without_ptc) = render_from_raw(&raw_no_ptc, &model).unwrap();
    assert_eq!(with_ptc.len(), without_ptc.len());
    let diffs: usize = with_ptc
        .iter()
        .zip(without_ptc.iter())
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(
        diffs, 0,
        "under colorimetry-only DCP (#425), PTC must be suppressed on \
         every profile source — got {} differing bytes between \
         with-PTC and without-PTC renders",
        diffs
    );
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_test_0002_exposure_max_is_brighter_than_baseline() {
    let path = require_raw("test_0002.dng");
    let model_baseline = AdjustmentModel::default();
    let model_bright = AdjustmentModel {
        exposure: 4.0,
        ..Default::default()
    };
    let (_, _, baseline) = render_path(&path, &model_baseline).unwrap();
    let (_, _, bright) = render_path(&path, &model_bright).unwrap();
    let mean_baseline: u64 =
        baseline.iter().map(|&b| b as u64).sum::<u64>() / baseline.len() as u64;
    let mean_bright: u64 = bright.iter().map(|&b| b as u64).sum::<u64>() / bright.len() as u64;
    assert!(
        mean_bright > mean_baseline,
        "+4EV ({}) should exceed baseline ({})",
        mean_bright,
        mean_baseline
    );
}

/// New scene-linear FFI entry. Returns Rec.2020 fp16 RGBA, half-res for
/// Preview, full for Full. Verify: the buffer is 8 bytes/pixel (4 ×
/// fp16), alpha is 1.0 everywhere, and the buffer is non-zero.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let (w, h, fp16_rgba) =
        render_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview)
            .expect("scene-linear preview render");
    // Each pixel = 4 channels × 2 bytes = 8 bytes; the Vec is u16 (fp16
    // bit pattern), so length = 4 × w × h.
    assert_eq!(
        fp16_rgba.len() as u32,
        4 * w * h,
        "expected 4 × w × h fp16 lanes, got {} for {}×{}",
        fp16_rgba.len(),
        w,
        h
    );
    // Alpha (every 4th lane) must be the fp16 pattern of 1.0 (0x3c00).
    let mut alpha_ok = 0usize;
    for chunk in fp16_rgba.chunks_exact(4) {
        if chunk[3] == 0x3c00 {
            alpha_ok += 1;
        }
    }
    assert_eq!(
        alpha_ok,
        (w * h) as usize,
        "expected {} alpha=1.0 lanes, got {}",
        w * h,
        alpha_ok
    );
    // Buffer is not all zeros.
    let nonzero = fp16_rgba.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
    assert!(
        nonzero > (fp16_rgba.len() / 10),
        "buffer mostly zero: {} non-zero/non-alpha lanes",
        nonzero
    );
}

/// Sized scene-linear FFI entry: caps the long edge at a viewport
/// budget. Verify: the returned buffer's long edge equals the cap
/// (or stays at the source dimension if the source is smaller — no
/// upscale per ticket 06 § Product Requirements 1), and the alpha
/// lane is 1.0 everywhere.
/// f32 scene-linear entry (#482). Mirrors the fp16 test: 4×w×h lanes,
/// alpha=1.0 everywhere, non-zero values present. The packed f32
/// buffer is the precision-preserving alternative to the fp16 surface
/// — fp16 loses ~3 bits of mantissa in highlights/shadows, which
/// shows up as banding on smooth gradients.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_f32_test_0002_preview_returns_rec2020_f32_rgba() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let (w, h, f32_rgba) =
        render_scene_linear_from_raw_with_quality_f32(&raw, &model, RenderQuality::Preview)
            .expect("scene-linear f32 preview render");
    assert_eq!(
        f32_rgba.len() as u32,
        4 * w * h,
        "expected 4 × w × h f32 lanes, got {} for {}×{}",
        f32_rgba.len(),
        w,
        h
    );
    // Alpha (every 4th lane) must be exactly 1.0.
    for chunk in f32_rgba.chunks_exact(4) {
        assert_eq!(chunk[3], 1.0_f32, "alpha != 1.0 in f32 buffer");
    }
    // Buffer is not all zeros.
    let nonzero = f32_rgba
        .chunks_exact(4)
        .filter(|c| c[0] != 0.0 || c[1] != 0.0 || c[2] != 0.0)
        .count();
    assert!(
        nonzero > (f32_rgba.len() / 40),
        "buffer mostly zero: {} non-zero RGB pixels",
        nonzero
    );
    // Every value is finite (no NaN / Inf leaked from the develop chain).
    assert!(
        f32_rgba.iter().all(|v| v.is_finite()),
        "non-finite values in f32 scene-linear buffer"
    );
}

/// f32 sized variant: caps the long edge and produces packed f32
/// alpha=1.0 lanes.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_sized_f32_test_0002_caps_long_edge_at_1500() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let max_long_edge: u32 = 1500;
    let (w, h, f32_rgba) = render_scene_linear_sized_from_raw_with_quality_f32(
        &raw,
        &model,
        RenderQuality::Preview,
        max_long_edge,
    )
    .expect("scene-linear sized f32 preview render");
    assert!(
        w.max(h) <= max_long_edge,
        "long edge exceeded cap: {}x{} > {}",
        w,
        h,
        max_long_edge
    );
    assert_eq!(f32_rgba.len() as u32, 4 * w * h);
    for chunk in f32_rgba.chunks_exact(4) {
        assert_eq!(chunk[3], 1.0_f32, "alpha != 1.0 in sized f32 buffer");
    }
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_sized_test_0002_caps_long_edge_at_1500() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let max_long_edge: u32 = 1500;
    let (w, h, fp16_rgba) = render_scene_linear_sized_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Preview,
        max_long_edge,
    )
    .expect("scene-linear sized preview render");
    // Cap respected on the long edge.
    assert!(
        w.max(h) <= max_long_edge,
        "long edge exceeded cap: {}x{} > {}",
        w,
        h,
        max_long_edge
    );
    // Buffer length matches.
    assert_eq!(fp16_rgba.len() as u32, 4 * w * h);
    // Alpha = 1.0 everywhere.
    for chunk in fp16_rgba.chunks_exact(4) {
        assert_eq!(chunk[3], 0x3c00, "alpha != 1.0 in sized buffer");
    }
}

#[test]
fn render_from_scene_linear_neutral_ramp_is_monotone() {
    let ramp = neutral_ramp(64, 4);
    // Force `Look::Neutral` here — this test validates a structural
    // pipeline invariant (achromatic input yields achromatic output,
    // monotone ramp stays monotone) and the empirical Look LUT has
    // intentionally different per-channel curves (R/G floor at ~7, B
    // floor at ~19), which makes neutral-axis preservation
    // colorimetric, not byte-exact. Pipeline aesthetics are tested
    // separately by the parity harness; this is the invariant gate.
    let model = AdjustmentModel {
        look: crate::view::look::Look::Neutral,
        ..AdjustmentModel::default()
    };
    let (w, h, bytes) = render_from_scene_linear(ramp, &model).expect("synthetic ramp render");
    assert_eq!(w, 64);
    assert_eq!(h, 4);
    assert_eq!(bytes.len(), (w * h * 3) as usize);
    // First row, channel R: must be monotone non-decreasing.
    for x in 1..w as usize {
        let prev = bytes[(x - 1) * 3] as i32;
        let cur = bytes[x * 3] as i32;
        assert!(cur >= prev, "non-monotone at x={}: {} -> {}", x, prev, cur);
    }
    // Achromatic: R == G == B at every pixel (tolerance for view-
    // transform / quantize rounding).
    for x in 0..w as usize {
        let r = bytes[x * 3];
        let g = bytes[x * 3 + 1];
        let b = bytes[x * 3 + 2];
        assert!(
            (r as i32 - g as i32).abs() <= 2,
            "R-G drift at x={}: {} vs {}",
            x,
            r,
            g
        );
        assert!(
            (g as i32 - b as i32).abs() <= 2,
            "G-B drift at x={}: {} vs {}",
            x,
            g,
            b
        );
    }
}

/// Banding-sanity gate (#482). A high-resolution (4096-wide) neutral
/// 0→1 ramp run through the view transform (AgX + sRGB encode + 8-bit
/// quantise) must produce a smooth, monotone 8-bit gradient with no
/// wide plateaus.
///
/// fp16 banding fingerprint on a smooth gradient: ~3 bits of mantissa
/// drop out near the AgX shoulder, producing a "jump-then-plateau"
/// pattern — adjacent scene-linear values get collapsed onto the same
/// fp16 bucket, then the next bucket jumps by several codes. A clean
/// f32 scene buffer produces every adjacent step ≤ 1 code at this
/// resolution.
///
/// We use 4096 pixels so each scene-linear step is 1/4096 ≈ 0.000244,
/// well below the smallest derivative of AgX × sRGB encode × u8 quantize
/// on the ramp. At that resolution every code transition takes ≥ 1
/// pixel; the f32 pipeline never skips. fp16 storage in the scene
/// buffer would produce visible +2 / +3 steps around the AgX shoulder
/// transitions.
///
/// The Rust path is f32 today; this test guards against an accidental
/// round-trip through fp16 (e.g. routing the scene buffer through the
/// legacy fp16 FFI surface). The Web equivalent lives in
/// `pipeline.spec.ts` (#482) — skip-passes under jsdom.
#[test]
fn neutral_ramp_view_transform_produces_no_banding_at_high_resolution() {
    use crate::synthetic_input::neutral_ramp;
    let width: u32 = 4096;
    let ramp = neutral_ramp(width, 1);
    // Force Look::Neutral — the empirical LUT introduces per-channel
    // floors that violate strict-monotonicity by design. Banding gate
    // is on the upstream pipeline, not the LUT.
    let model = AdjustmentModel {
        look: crate::view::look::Look::Neutral,
        ..AdjustmentModel::default()
    };
    let (w, _h, bytes) = render_from_scene_linear(ramp, &model).expect("ramp render");
    assert_eq!(w, width);
    // Green channel at byte offset 1 (Rec.2020 luma weight is highest
    // on green, so banding shows up there first).
    let row: Vec<u8> = (0..w as usize).map(|x| bytes[x * 3 + 1]).collect();
    // Every adjacent step must be 0 or +1. A +2 step at this
    // resolution would indicate fp16-precision banding.
    let mut max_step: i32 = 0;
    let mut max_step_x: usize = 0;
    for x in 1..row.len() {
        let step = row[x] as i32 - row[x - 1] as i32;
        if step > max_step {
            max_step = step;
            max_step_x = x;
        }
    }
    assert!(
        max_step <= 1,
        "banding: max step in 4096-px ramp = +{} at x={} ({} → {}) — \
         must be <= +1 for a clean f32 scene buffer (fp16 storage in \
         the scene buffer would produce +2 / +3 jumps near the AgX \
         shoulder)",
        max_step,
        max_step_x,
        row[max_step_x - 1],
        row[max_step_x]
    );
}

// Note: a paired "negative control" that round-trips the input ramp
// through fp16 once does NOT produce visible banding at 4096-px
// resolution — a single fp16 truncation has 11-bit mantissa precision
// in [0, 1], which is below the 8-bit quantize threshold. The
// banding artefact emerges when MULTIPLE stages compound their
// fp16 truncations (the WebGL ping-pong chain runs ~5 sequential
// passes, each storing back into RGBA16F). The Rust-side gate above
// is a positive smoke test that proves the f32 pipeline doesn't
// self-produce wide jumps; the meaningful fp16-vs-f32 regression
// surface lives on the WebGL side (#482) where the chain depth
// exposes accumulated truncation.

#[test]
fn render_from_scene_linear_uniform_hue_patch_is_uniform_output() {
    let patch = hue_patch(Primary::Red, 0.0, 8, 8);
    let model = AdjustmentModel::default();
    let (w, h, bytes) =
        render_from_scene_linear(patch, &model).expect("synthetic hue patch render");
    // ±1 LSB spread permitted: #441 ordered dither adds ±0.5 LSB
    // pre-quantize, so a uniform scene-linear input can land at
    // adjacent u8 codes for different pixel positions. The gate is
    // "no spatial noise beyond the documented dither bound," not
    // bit-exact equality across pixels.
    let mut r_lo = u8::MAX;
    let mut r_hi = u8::MIN;
    let mut g_lo = u8::MAX;
    let mut g_hi = u8::MIN;
    let mut b_lo = u8::MAX;
    let mut b_hi = u8::MIN;
    for i in 0..(w * h) as usize {
        let r = bytes[i * 3];
        let g = bytes[i * 3 + 1];
        let b = bytes[i * 3 + 2];
        r_lo = r_lo.min(r);
        r_hi = r_hi.max(r);
        g_lo = g_lo.min(g);
        g_hi = g_hi.max(g);
        b_lo = b_lo.min(b);
        b_hi = b_hi.max(b);
    }
    assert!(
        r_hi - r_lo <= 1,
        "R spread {}..{} > 1 LSB (dither bound)",
        r_lo,
        r_hi
    );
    assert!(
        g_hi - g_lo <= 1,
        "G spread {}..{} > 1 LSB (dither bound)",
        g_lo,
        g_hi
    );
    assert!(
        b_hi - b_lo <= 1,
        "B spread {}..{} > 1 LSB (dither bound)",
        b_lo,
        b_hi
    );
}

#[test]
fn render_from_scene_linear_halo_disk_dark_center_bright_corners() {
    let disk = halo_disk(64, 64);
    let model = AdjustmentModel::default();
    let (w, h, bytes) = render_from_scene_linear(disk, &model).expect("synthetic halo render");
    assert_eq!(w, 64);
    assert_eq!(h, 64);
    let center_r = bytes[(32 * 64 + 32) * 3] as i32;
    let corner_r = bytes[0] as i32;
    assert!(
        center_r < corner_r - 30,
        "halo center / corner contrast collapsed: center={} corner={}",
        center_r,
        corner_r
    );
}

#[test]
fn render_from_scene_linear_with_chain_dehaze_zero_is_passthrough() {
    // With every slider at default (0), the chain should produce the
    // same bytes as the view-transform-only path (modulo a couple
    // levels of u8 rounding from the extra Oklab round-trips).
    //
    // Force `Look::Neutral` here — sub-1-unit float drift in the chain
    // path can index either side of a step in the Look LUT, producing
    // up to a few u8 of post-LUT divergence even though the underlying
    // pipelines match within float tolerance. This test gates pipeline
    // equivalence, not the Look layer.
    let ramp_a = neutral_ramp(32, 2);
    let ramp_b = neutral_ramp(32, 2);
    let model = AdjustmentModel {
        look: crate::view::look::Look::Neutral,
        ..AdjustmentModel::default()
    };
    let (_, _, plain) = render_from_scene_linear(ramp_a, &model).unwrap();
    let (_, _, chained) = render_from_scene_linear_with_chain(ramp_b, &model).unwrap();
    assert_eq!(plain.len(), chained.len());
    let max_diff = plain
        .iter()
        .zip(chained.iter())
        .map(|(a, b)| (*a as i32 - *b as i32).abs())
        .max()
        .unwrap();
    assert!(
        max_diff <= 3,
        "default model with-chain vs no-chain should match (max diff {})",
        max_diff
    );
}

// T6 Auto Profile dispatch tests live in the sibling `tests_dispatch.rs` file
// to keep both files under the 600-LOC hard budget.
