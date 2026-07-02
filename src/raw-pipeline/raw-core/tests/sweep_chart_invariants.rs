//! Invariants for the dense 3072-patch ACR sweep chart (Phase 2, #1719).
//!
//! Three gates:
//!   1. Sweep chart decodes and resolves to EmbeddedCmOnly (not RawlerFallback).
//!   2. Develop scene-linear: a sampled subset (~200 patches incl. all neutrals)
//!      match the spec targets within a self-calibrated global gain G.
//!   3. Spec JSON round-trip: dump → parse targets → compare to in-memory spec.
//!
//! These tests are fast even though the DNG is large (3584×2688 = 9.6 MP)
//! because we sample only 200 of the 3072 patches for the develop gate.
//!
//! Refs: #1719, Phase 2 of epic #1710.

#![cfg(feature = "test-support")]

use raw_core::color::dcp::ProfileSource;
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_sweep::{
    SyntheticSweepChart, COLS, GUARD, NEUTRAL_ROWS, N_PATCHES, PATCH_SIZE, ROWS, SWEEP_ROWS,
};
use raw_core::xmp::AdjustmentModel;

// ── Gate 1: EmbeddedCmOnly resolution ─────────────────────────────────────────

/// The sweep chart must resolve to EmbeddedCmOnly, not RawlerFallback.
/// Same reasoning as the 24-patch chart: UCM = "Maple Synthetic Sweep Chart"
/// has no bundle entry, but CM1 = M_XYZ_D65_TO_REC2020 is non-identity so it
/// passes the identity filter.
#[test]
fn sweep_chart_resolves_to_embedded_cm_only() {
    use raw_core::color::dcp::profile_for_with_source;

    let chart = SyntheticSweepChart::new();
    let bytes = chart.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("sweep chart must decode");

    assert!(
        !raw.color_matrices.is_empty(),
        "sweep chart CM was filtered as identity (color_matrices is empty)"
    );

    let (_, src) =
        profile_for_with_source(&raw).expect("sweep chart profile resolve must not error");
    assert!(
        matches!(src, ProfileSource::EmbeddedCmOnly { .. }),
        "sweep chart must resolve to EmbeddedCmOnly, got {:?}",
        src
    );
}

// ── Shared develop helper ─────────────────────────────────────────────────────

/// Develop the sweep chart to scene-linear and return the chart + image.
///
/// This is expensive (9.6 MP demosaic) so tests share it via a module-level
/// `OnceLock` — the lock is inside each test function to avoid init-order
/// surprises.
fn developed_chart_and_image() -> &'static (SyntheticSweepChart, raw_core::image::Image) {
    static ONCE: std::sync::OnceLock<(SyntheticSweepChart, raw_core::image::Image)> =
        std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let chart = SyntheticSweepChart::new();
        let bytes = chart.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("sweep chart must decode");
        let scene = develop_scene_linear_from_raw_with_quality(
            &raw,
            &AdjustmentModel::default(),
            RenderQuality::Full,
        )
        .expect("sweep chart develop must succeed");
        (chart, scene)
    })
}

// ── Gate 2: patch means match spec targets within global gain ─────────────────

/// Sample ~200 patches (all 128 neutrals + stride-14 sweep samples) and assert
/// that each developed mean matches `G * target` within 1e-3.
///
/// The global gain G is self-calibrated over the sampled set by least-squares
/// (same approach as `color_chart_invariants.rs`). A valid G is in [1.0, 1.4).
#[test]
fn sweep_chart_sampled_patch_means_match_spec_targets() {
    const EPS: f32 = 1e-3;

    let (chart, scene) = developed_chart_and_image();
    let w = scene.width as usize;

    // Helper: read mean of patch (col, row) inner core.
    // Inner core: skip GUARD/2 = 4 px on each side, same as SyntheticColorChart.
    let read_patch_mean = |col: u32, row: u32| -> [f32; 3] {
        let stride = (PATCH_SIZE + GUARD) as usize;
        let x0 = col as usize * stride + 4;
        let y0 = row as usize * stride + 4;
        let inner = PATCH_SIZE as usize - 8;
        let mut sums = [0.0_f64; 3];
        let mut n = 0u64;
        for dy in 0..inner {
            for dx in 0..inner {
                let i = (y0 + dy) * w + (x0 + dx);
                if i >= scene.pixels.len() {
                    continue;
                }
                let p = scene.pixels[i];
                sums[0] += p[0] as f64;
                sums[1] += p[1] as f64;
                sums[2] += p[2] as f64;
                n += 1;
            }
        }
        let nn = n.max(1) as f64;
        [
            (sums[0] / nn) as f32,
            (sums[1] / nn) as f32,
            (sums[2] / nn) as f32,
        ]
    };

    // Build sample set: all neutral patches + every 14th sweep patch.
    let mut samples: Vec<(u32, u32)> = Vec::with_capacity(200);
    // All 128 neutral patches (rows 0–1).
    for row in 0..NEUTRAL_ROWS {
        for col in 0..COLS {
            samples.push((col, row));
        }
    }
    // Stride-14 sweep patches (rows 2–43).
    {
        let mut flat_count = 0usize;
        'outer: for row in NEUTRAL_ROWS..NEUTRAL_ROWS + SWEEP_ROWS {
            for col in 0..COLS {
                if flat_count % 14 == 0 {
                    samples.push((col, row));
                    if samples.len() >= 250 {
                        break 'outer;
                    }
                }
                flat_count += 1;
            }
        }
    }

    // Self-calibrate G by LSQ, excluding clamped patches and patches whose
    // target exceeds [0, 1] (the DNG's 16-bit range can't represent > 1.0).
    let is_in_range = |want: [f32; 3]| want.iter().all(|&v| v >= 0.0 && v <= 1.0);

    let (mut num, mut den) = (0.0f64, 0.0f64);
    for &(col, row) in &samples {
        let spec = chart.spec_at(col, row);
        if spec.clamped || !is_in_range(spec.target_rec2020) {
            continue;
        }
        let got = read_patch_mean(col, row);
        let want = spec.target_rec2020;
        for c in 0..3 {
            num += (got[c] * want[c]) as f64;
            den += (want[c] * want[c]) as f64;
        }
    }
    let g = (num / den) as f32;

    assert!(
        (1.0..1.4).contains(&g),
        "sweep chart: develop gain G={g} outside sane range [1.0, 1.4)"
    );

    // Assert per-patch residual, skipping clamped and out-of-range patches.
    for &(col, row) in &samples {
        let spec = chart.spec_at(col, row);
        if spec.clamped || !is_in_range(spec.target_rec2020) {
            continue;
        }
        let got = read_patch_mean(col, row);
        let want = spec.target_rec2020;
        for c in 0..3 {
            let resid = (got[c] - g * want[c]).abs();
            assert!(
                resid <= EPS,
                "sweep patch ({col},{row}) chan {c}: \
                 |got {:.6} - G*want {:.6}| = {resid:.6} > {EPS} (G={g:.4})",
                got[c],
                g * want[c],
            );
        }
    }
}

// ── Gate 3: spec JSON round-trip ──────────────────────────────────────────────

/// Serialise the spec to JSON, parse it back, and assert targets match.
#[test]
fn sweep_chart_spec_json_round_trips() {
    let chart = SyntheticSweepChart::new();
    let json = chart.spec_to_json();

    // Parse the JSON array (hand-parsed to avoid pulling in serde).
    // We just verify a sample of entries: index 0, 63, 128, 3071.
    for &target_idx in &[0usize, 63, 128, 3071] {
        let spec = &chart.specs()[target_idx];

        // Build the exact expected JSON line for this entry.
        let expected_line = spec.to_json_line();

        // The JSON array must contain this line.
        assert!(
            json.contains(&expected_line),
            "JSON round-trip failed for index {target_idx}: expected line not found.\n\
             Expected: {expected_line}"
        );

        // Verify the target values can be extracted from the line by parsing
        // the three floats in "target_rec2020":[r,g,b].
        let parsed = parse_target_from_json_line(&expected_line);
        let want = spec.target_rec2020;
        for c in 0..3 {
            assert!(
                (parsed[c] - want[c]).abs() < 1e-5,
                "round-trip chan {c} for index {target_idx}: parsed {:.7} vs want {:.7}",
                parsed[c],
                want[c]
            );
        }
    }
}

/// Minimal JSON parser for the `target_rec2020` field in a patch-spec JSON line.
fn parse_target_from_json_line(line: &str) -> [f32; 3] {
    let key = "\"target_rec2020\":[";
    let start = line
        .find(key)
        .expect("target_rec2020 not found in JSON line")
        + key.len();
    let end = line[start..].find(']').expect("closing ] not found") + start;
    let inner = &line[start..end];
    let parts: Vec<f32> = inner
        .split(',')
        .map(|s| s.trim().parse::<f32>().expect("float parse failed"))
        .collect();
    assert_eq!(parts.len(), 3, "expected 3 floats in target_rec2020");
    [parts[0], parts[1], parts[2]]
}

// ── Structural sanity ─────────────────────────────────────────────────────────

#[test]
fn sweep_chart_has_correct_patch_count() {
    let chart = SyntheticSweepChart::new();
    assert_eq!(chart.specs().len(), N_PATCHES);
    assert_eq!(COLS * ROWS, N_PATCHES as u32);
}
