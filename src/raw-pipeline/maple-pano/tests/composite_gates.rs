//! M2-CPU acceptance gates (#1155) — the compositing chain against
//! ground truth: the §7 warp-RMSE gate, full-ring wrap closure, linear
//! gain recovery, validity edges, and determinism. All gates use
//! exactly-known cameras (no solver) so they measure compositing alone.

use maple_pano::blend::blend_multiband;
use maple_pano::camera::Camera;
use maple_pano::composite::{composite, composite_tiled_frames, CompositeOptions};
use maple_pano::gain::GainMode;
use maple_pano::ingest::{PlanarImage, ValidityMask};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::seam::masks::build_from_frames;
use maple_pano::seam::SeamStrategy;
use maple_pano::source::EquirectSource;
use maple_pano::warp::warp_to_canvas;

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
    // solve_photometry fixes the gauge to geometric mean = 1, and the planted
    // scales {2, ½, 1, 1, 1, 1} have geometric mean 1 — so the expected
    // gains are exactly the inverses.
    for i in 0..frames.len() {
        let expected = 1.0 / scales[i] as f64;
        let got = report.photometry[i].gain[0] as f64;
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

// ─── Tiling invariant (M6-D #1248, multi-band #4524) ─────────────────────────

/// Validity mismatches and the largest per-channel value gap over pixels
/// both images mark valid.
fn image_gap(a: &PlanarImage, b: &PlanarImage) -> (usize, f32) {
    assert_eq!((a.width(), a.height()), (b.width(), b.height()), "shape");
    let w = a.width() as usize;
    (0..a.r.len()).fold((0, 0.0_f32), |(mismatch, gap), i| {
        let (x, y) = ((i % w) as u32, (i / w) as u32);
        match (a.validity.get(x, y), b.validity.get(x, y)) {
            (true, true) => {
                let d = [(&a.r, &b.r), (&a.g, &b.g), (&a.b, &b.b)]
                    .iter()
                    .map(|(p, q)| (p[i] - q[i]).abs())
                    .fold(gap, f32::max);
                (mismatch, d)
            }
            (false, false) => (mismatch, gap),
            _ => (mismatch + 1, gap),
        }
    })
}

/// Tiling invariant: the Voronoi tiled path multi-band blends to the same
/// pixels as the REAL whole-canvas `composite` at its automatic band count
/// (> 1), for every strip height — including non-divisors of the canvas
/// height that land off the coarse pyramid grid, and the no-split case.
#[test]
fn tiling_equals_real_composite() {
    // 6-frame partial ring: non-trivial overlap, no full wrap (we want
    // uncovered pixels to stay invalid — a full ring would cover everything
    // and not exercise the validity-boundary logic).
    let source = scene(77);
    let cams = camera_set(&ring(6, 55.0, false), 11);
    let frames = gt_frames(&source, &cams);

    let (reference, report) =
        composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("reference");
    let canvas = &report.canvas;
    println!(
        "reference: {}x{} canvas, {} valid px, {} bands (min overlap {} px)",
        canvas.width,
        canvas.height,
        reference.validity.count_valid(),
        report.blend_levels,
        report.min_overlap_width_px
    );
    assert!(report.blend_levels > 1, "gate must exercise a real pyramid");
    assert!(reference.validity.count_valid() > 0);

    for tile_rows in [37u32, 128, canvas.height] {
        let (tiled, tiled_report) = composite_tiled_frames(
            &frames,
            &cams,
            &report.photometry,
            &[],
            canvas,
            tile_rows,
            SeamStrategy::Voronoi,
        )
        .expect("tiled composite");
        assert_eq!(tiled_report.blend_levels, report.blend_levels);
        let (mismatches, gap) = image_gap(&tiled, &reference);
        println!("tile_rows={tile_rows}: {mismatches} validity mismatches, max gap {gap:e}");
        assert_eq!(mismatches, 0, "tile_rows={tile_rows}: validity differs");
        assert!(
            gap <= 1e-6,
            "tile_rows={tile_rows}: max gap {gap} vs composite"
        );
    }
}

/// Graph-cut tiled path: strip height never changes the pixels, and the
/// result equals a whole-canvas `blend_multiband` of the fully warped
/// layers under the same seam weights.
#[test]
fn graph_cut_tiling_is_strip_invariant_multiband() {
    let source = scene(31);
    let cams = camera_set(&ring(4, 60.0, false), 5);
    let frames = gt_frames(&source, &cams);
    let (_, report) = composite(&frames, &cams, &CompositeOptions::default(), &[]).expect("canvas");
    let canvas = &report.canvas;

    let tiled_at = |tile_rows: u32| {
        composite_tiled_frames(
            &frames,
            &cams,
            &report.photometry,
            &[],
            canvas,
            tile_rows,
            SeamStrategy::GraphCut,
        )
        .expect("graph-cut tiled")
    };
    let (full, full_report) = tiled_at(canvas.height);
    assert!(
        full_report.blend_levels > 1,
        "gate must exercise a real pyramid"
    );

    let seam = build_from_frames(&frames, &cams, &report.photometry, &[], canvas);
    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(&cams)
        .zip(&report.photometry)
        .map(|((f, c), &g)| warp_to_canvas(f, c, canvas, g, None))
        .collect();
    let cw = canvas.width as usize;
    let weights: Vec<Vec<f32>> = (0..layers.len())
        .map(|fi| {
            (0..layers[fi].r.len())
                .map(|i| seam.weight(fi, (i % cw) as f64 + 0.5, (i / cw) as f64 + 0.5))
                .collect()
        })
        .collect();
    let reference = blend_multiband(&layers, &weights, full_report.blend_levels);
    let (mismatches, gap) = image_gap(&full, &reference);
    println!("graph-cut vs blend_multiband: {mismatches} validity mismatches, max gap {gap:e}");
    assert_eq!(mismatches, 0);
    assert!(
        gap <= 1e-6,
        "graph-cut tiled vs whole-canvas multiband: {gap}"
    );

    for tile_rows in [29u32, 100] {
        let (tiled, _) = tiled_at(tile_rows);
        let (mismatches, gap) = image_gap(&tiled, &full);
        assert_eq!(mismatches, 0, "tile_rows={tile_rows}: validity differs");
        assert!(gap <= 1e-6, "tile_rows={tile_rows}: max gap {gap}");
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
