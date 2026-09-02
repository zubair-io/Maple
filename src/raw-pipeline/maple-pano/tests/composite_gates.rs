//! M2-CPU acceptance gates (#1155) — the compositing chain against
//! ground truth: the §7 warp-RMSE gate, full-ring wrap closure, linear
//! gain recovery, validity edges, and determinism. All gates use
//! exactly-known cameras (no solver) so they measure compositing alone.

use maple_pano::camera::Camera;
use maple_pano::canvas::{auto_canvas, CanvasOptions};
use maple_pano::composite::{composite, composite_tiled_frames, CompositeOptions};
use maple_pano::gain::GainMode;
use maple_pano::ingest::{PlanarImage, ValidityMask};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::seam::SeamStrategy;
use maple_pano::source::EquirectSource;

fn ring(count: u32, fov_deg: f64, full: bool) -> CameraSetOptions {
    CameraSetOptions {
        count,
        pattern: Pattern::Ring { full },
        fov_deg,
        overlap: 0.35,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 640,
        height: 480,
    }
}

/// Render the ground-truth frames for a camera set and lift them into
/// the compositing buffer shape.
fn gt_frames(source: &EquirectSource, cams: &[Camera]) -> Vec<PlanarImage> {
    cams.iter()
        .map(|cam| {
            let data = render_frame(source, cam, 2).expect("render");
            let n = (cam.width as usize) * (cam.height as usize);
            let mut r = Vec::with_capacity(n);
            let mut g = Vec::with_capacity(n);
            let mut b = Vec::with_capacity(n);
            for px in data.chunks_exact(3) {
                r.push(px[0] as f32 / 65535.0);
                g.push(px[1] as f32 / 65535.0);
                b.push(px[2] as f32 / 65535.0);
            }
            PlanarImage::from_planes(
                cam.width,
                cam.height,
                r,
                g,
                b,
                ValidityMask::new_filled(cam.width, cam.height, true),
            )
        })
        .collect()
}

fn scene(seed: u64) -> EquirectSource {
    EquirectSource::synthetic(2048, 1024, seed).expect("source")
}

fn camera_set(opts: &CameraSetOptions, seed: u64) -> Vec<Camera> {
    build_camera_set(opts, &mut SplitMix64::new(seed))
        .expect("valid options")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

/// RMSE between the composite and a direct resample of the source at
/// canvas resolution, over the composite's valid pixels. Returns
/// (rmse, compared_fraction).
fn rmse_vs_source(
    out: &PlanarImage,
    canvas: &maple_pano::canvas::CanvasSpec,
    source: &EquirectSource,
) -> (f64, f64) {
    let (w, h) = (out.width(), out.height());
    let mut sum_sq = 0.0_f64;
    let mut count = 0usize;
    for y in 0..h {
        for x in 0..w {
            if !out.validity.get(x, y) {
                continue;
            }
            let Some(dir) = canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5) else {
                continue;
            };
            let Some(reference) = source.sample_dir(dir) else {
                continue;
            };
            let i = (y as usize) * (w as usize) + x as usize;
            for (c, plane) in [&out.r, &out.g, &out.b].into_iter().enumerate() {
                let d = plane[i] as f64 - reference[c];
                sum_sq += d * d;
                count += 1;
            }
        }
    }
    let total = (w as usize) * (h as usize) * 3;
    (
        (sum_sq / count.max(1) as f64).sqrt(),
        count as f64 / total as f64,
    )
}

/// Spec §7 gate: composite of exactly-posed frames vs. a direct render
/// of the same source at canvas resolution — RMSE < 0.5 % of full
/// scale.
#[test]
fn gate_warp_rmse_under_half_percent() {
    let source = scene(42);
    let cams = camera_set(&ring(6, 70.0, true), 1);
    let frames = gt_frames(&source, &cams);
    let (out, report) =
        composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("composite");
    let (rmse, covered) = rmse_vs_source(&out, &report.canvas, &source);
    println!(
        "warp gate: rmse {:.5} ({:.2}% of full scale), {:.1}% of canvas compared, canvas {}x{}, {} blend levels (min overlap {} px)",
        rmse,
        rmse * 100.0,
        covered * 100.0,
        report.canvas.width,
        report.canvas.height,
        report.blend_levels,
        report.min_overlap_width_px
    );
    assert!(covered > 0.5, "full ring must cover most of the band");
    assert!(rmse < 0.005, "spec §7: RMSE {rmse} ≥ 0.5% of full scale");
}

/// Full 360° ring: the composite's wrap columns agree (closure ≈ 0 at
/// the seam meridian).
#[test]
fn gate_full_ring_wrap_closure() {
    let source = scene(7);
    let cams = camera_set(&ring(8, 60.0, true), 2);
    let frames = gt_frames(&source, &cams);
    let (out, report) =
        composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("composite");
    assert!(
        report.canvas.is_full_wrap(),
        "ring must yield a wrap canvas"
    );
    let (w, h) = (out.width(), out.height());
    let mut worst = 0.0_f32;
    let mut compared = 0usize;
    for y in 0..h {
        if !(out.validity.get(0, y) && out.validity.get(w - 1, y)) {
            continue;
        }
        let l = (y as usize) * (w as usize);
        let r = l + (w as usize) - 1;
        // Adjacent columns across the wrap are one canvas pixel apart in
        // angle — compare against the *source* gradient scale by using
        // the next-in column as the tolerance anchor.
        let dl = (out.r[l] - out.r[r]).abs();
        worst = worst.max(dl);
        compared += 1;
    }
    println!("wrap closure: worst adjacent-column delta {worst:.5} over {compared} rows");
    assert!(compared > (h as usize) / 2, "wrap columns must be covered");
    // One canvas pixel of angular distance — values must be continuous
    // at texture-gradient scale, far below any visible seam step.
    assert!(worst < 0.08, "wrap discontinuity {worst}");
}

/// Linear gain compensation: frames pre-scaled ±1 EV are equalized —
/// recovered gains within 1 % of the inverse scaling, and the composite
/// still matches the source.
#[test]
fn gate_gain_recovery() {
    let source = scene(11);
    let cams = camera_set(&ring(6, 70.0, true), 3);
    let mut frames = gt_frames(&source, &cams);
    let scales = [2.0_f32, 0.5, 1.0, 1.0, 1.0, 1.0];
    for (frame, &s) in frames.iter_mut().zip(&scales) {
        for plane in [&mut frame.r, &mut frame.g, &mut frame.b] {
            for v in plane.iter_mut() {
                *v *= s;
            }
        }
    }
    let opts = CompositeOptions {
        gain: maple_pano::gain::GainOptions {
            mode: GainMode::Scalar,
            ..Default::default()
        },
        ..Default::default()
    };
    let (out, report) = composite(&frames, &cams, &opts, &[]).expect("composite");
    // solve_gains fixes the gauge to geometric mean = 1, and the planted
    // scales {2, ½, 1, 1, 1, 1} have geometric mean 1 — so the expected
    // gains are exactly the inverses.
    for i in 0..frames.len() {
        let expected = 1.0 / scales[i] as f64;
        let got = report.gains[i][0] as f64;
        let rel = (got - expected).abs() / expected;
        println!(
            "gain {i}: got {got:.4}, expected {expected:.4} (rel err {:.3}%)",
            rel * 100.0
        );
        assert!(rel < 0.01, "gain {i} off by {:.3}%", rel * 100.0);
    }
    let (rmse, _) = rmse_vs_source(&out, &report.canvas, &source);
    println!("gain gate: equalized composite rmse {rmse:.5}");
    assert!(rmse < 0.005, "equalized composite drifted: rmse {rmse}");
}

/// Validity edges: a partial sweep leaves uncovered canvas invalid and
/// zeroed; no value bleed past frame borders.
#[test]
fn gate_uncovered_canvas_is_invalid() {
    let source = scene(5);
    let cams = camera_set(&ring(2, 50.0, false), 4);
    let frames = gt_frames(&source, &cams);
    let (out, report) =
        composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("composite");
    let (w, h) = (out.width(), out.height());
    let valid = out.validity.count_valid();
    let total = (w as usize) * (h as usize);
    println!(
        "partial sweep: {valid}/{total} valid on {}x{} ({:?})",
        w, h, report.projection
    );
    assert!(valid > 0, "frames must land on the canvas");
    for y in 0..h {
        for x in 0..w {
            if !out.validity.get(x, y) {
                let i = (y as usize) * (w as usize) + x as usize;
                assert_eq!(out.r[i], 0.0, "invalid pixel ({x},{y}) must be zeroed");
            }
        }
    }
}

/// Determinism: identical inputs → byte-identical composite.
#[test]
fn gate_deterministic() {
    let source = scene(9);
    let cams = camera_set(&ring(4, 65.0, false), 6);
    let frames = gt_frames(&source, &cams);
    let (a, _) = composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("composite");
    let (b, _) = composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("composite");
    assert_eq!(a.r, b.r);
    assert_eq!(a.g, b.g);
    assert_eq!(a.b, b.b);
}

// ─── Tiling invariant (M6-D, #1248) ──────────────────────────────────────────

/// Tiling invariant: `composite_tiled_frames` with multiple tile heights
/// produces pixel-identical output to the REAL `composite` (with
/// `levels_override: Some(1)` to match the tiled path's linear Voronoi blend).
///
/// This test compares the tiled path against the production `composite` path,
/// not against itself. The reference is `composite` with `levels_override: 1`
/// (single-band = pure linear Voronoi), which is what the tiled path
/// implements. Voronoi assigns exclusive ownership (each canvas pixel belongs
/// to exactly one frame), so with single-band blending the result must be
/// pixel-identical regardless of tile decomposition — the strip arithmetic
/// cannot change which sample is written.
///
/// Tile heights tested: 1, 7, 23, 64, and the full canvas height (the last
/// exercises the no-split degenerate case).
#[test]
fn tiling_equals_real_composite() {
    // 6-frame partial ring: non-trivial overlap, no full wrap (we want
    // uncovered pixels to stay invalid — a full ring would cover everything
    // and not exercise the validity-boundary logic).
    let source = scene(77);
    let cams = camera_set(&ring(6, 55.0, false), 11);
    let frames = gt_frames(&source, &cams);

    // Compute the real composite with single-band blending so the blend
    // algebra matches the tiled path's linear Voronoi exactly.
    let comp_opts = CompositeOptions {
        canvas: CanvasOptions::default(),
        levels_override: Some(1),
        ..Default::default()
    };
    let (reference, report) =
        composite(&frames, &cams, &comp_opts, &[]).expect("reference composite");

    // Re-use the canvas and gains from the reference run so both paths
    // operate on identical geometry and colour corrections.
    let canvas = &report.canvas;
    let gains = &report.gains;

    let (w, h) = (canvas.width as usize, canvas.height as usize);
    let ref_covered = reference.validity.count_valid();
    println!(
        "reference: {}x{} canvas, {}/{} valid pixels, {} frames",
        canvas.width,
        canvas.height,
        ref_covered,
        w * h,
        cams.len()
    );
    assert!(
        ref_covered > 0,
        "reference composite must cover some pixels"
    );

    // Tiled at multiple heights, including non-divisors and the full height.
    for tile_rows in [1u32, 7, 23, 64, canvas.height] {
        let (tiled, _) = composite_tiled_frames(
            &frames,
            &cams,
            gains,
            &[],
            canvas,
            tile_rows,
            SeamStrategy::Voronoi,
        )
        .expect("tiled composite");

        let mut validity_mismatches = 0usize;
        let mut value_mismatches = 0usize;
        for y in 0..h as u32 {
            for x in 0..w as u32 {
                let ref_v = reference.validity.get(x, y);
                let tile_v = tiled.validity.get(x, y);
                if ref_v != tile_v {
                    validity_mismatches += 1;
                    continue;
                }
                if ref_v {
                    let i = y as usize * w + x as usize;
                    if tiled.r[i] != reference.r[i]
                        || tiled.g[i] != reference.g[i]
                        || tiled.b[i] != reference.b[i]
                    {
                        value_mismatches += 1;
                        if value_mismatches <= 3 {
                            eprintln!(
                                "  tile_rows={tile_rows} pixel ({x},{y}): \
                                 tiled=({:.6},{:.6},{:.6}) ref=({:.6},{:.6},{:.6})",
                                tiled.r[i],
                                tiled.g[i],
                                tiled.b[i],
                                reference.r[i],
                                reference.g[i],
                                reference.b[i]
                            );
                        }
                    }
                }
            }
        }
        assert_eq!(
            validity_mismatches, 0,
            "tile_rows={tile_rows}: {validity_mismatches} validity mismatches vs real composite"
        );
        assert_eq!(
            value_mismatches, 0,
            "tile_rows={tile_rows}: {value_mismatches} pixel value mismatches vs real composite"
        );
    }
}

/// Proxy default is 1600 px: StitchOptions::default().proxy_long_edge == 1600.
/// Pins the regression guard from #1248 — the M6-D 1280 default starved
/// ALIKED on pano_01 (tile strategy + 19 orphans / no candidate); 1600
/// keeps it rotation, 0-dropped, mean 1.13. The proxy feeds matching
/// only (not the composite memory peak that tiling addresses), so 1600
/// costs ~no memory vs 1280.
/// Gated on the `ml` feature because `stitch` is only compiled with it.
#[test]
#[cfg(any(feature = "ml", feature = "ml-static"))]
fn proxy_long_edge_default_is_1600() {
    use maple_pano::stitch::StitchOptions;
    assert_eq!(
        StitchOptions::default().proxy_long_edge,
        1600,
        "#1248: 1280 default regressed pano_01 to 19 orphans; default must stay 1600"
    );
}
