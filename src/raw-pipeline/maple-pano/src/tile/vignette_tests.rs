//! Blind per-lens vignette gates on the tile path (#4522): a planted
//! elliptical falloff on a translation set is recovered and flattened
//! out of the composite.

use super::composite::composite_tile;
use super::placement::{TileCanvasSpec, TilePose};
use crate::composite::CanvasCollector;
use crate::frame_store::InMemory;
use crate::gain::vignette::{falloff_gain, radius_squared};
use crate::gain::{GainOptions, LensGroups};
use crate::ingest::{PlanarImage, ValidityMask};
use crate::similarity::Similarity2d;

const PLANTED_Q: f64 = 0.25;
/// Palindromic exposures: no linear trend over the frame order, which
/// layer A's zero-trend prior would otherwise fold into its ramp.
const MULS: [f32; 9] = [1.0, 1.2, 0.9, 1.1, 0.8, 1.1, 0.9, 1.2, 1.0];
const STEP: (f64, f64) = (40.0, 30.0);
const FRAME: (u32, u32) = (96, 72);

fn scene(cx: f64, cy: f64) -> f32 {
    (0.2 + 0.1 * (cx * 0.05).sin() * (cy * 0.07).cos() + 0.0005 * (cx + cy)) as f32
}

fn poses() -> Vec<TilePose> {
    (0..MULS.len())
        .map(|f| TilePose {
            frame_idx: f,
            sim: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx: (f % 3) as f64 * STEP.0,
                ty: (f / 3) as f64 * STEP.1,
            },
        })
        .collect()
}

fn canvas() -> TileCanvasSpec {
    TileCanvasSpec {
        width: FRAME.0 + 2 * STEP.0 as u32,
        height: FRAME.1 + 2 * STEP.1 as u32,
        offset_x: 0.0,
        offset_y: 0.0,
    }
}

fn planted(q: f64) -> Vec<PlanarImage> {
    let (w, h) = FRAME;
    poses()
        .iter()
        .zip(MULS)
        .map(|(pose, m)| {
            let px: Vec<f32> = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x as f64 + 0.5, y as f64 + 0.5)))
                .map(|(x, y)| {
                    let falloff = falloff_gain(q, radius_squared(x, y, w as f64, h as f64));
                    scene(x + pose.sim.tx, y + pose.sim.ty) * m / falloff as f32
                })
                .collect();
            PlanarImage::from_planes(
                w,
                h,
                px.clone(),
                px.clone(),
                px,
                ValidityMask::new_filled(w, h, true),
            )
        })
        .collect()
}

fn one_lens() -> LensGroups {
    LensGroups {
        labels: vec!["Test Synthetic".into()],
        of_frame: vec![Some(0); MULS.len()],
    }
}

/// `max / min` of composite-over-scene across the canvas: 1 when the
/// composite is the scene up to one global exposure.
fn ripple(frames: Vec<PlanarImage>, lenses: &LensGroups) -> (f64, Vec<crate::gain::LensFalloff>) {
    let full_dims = vec![FRAME; MULS.len()];
    let frames = InMemory(&frames);
    let canvas = canvas();
    let mut collector = CanvasCollector::default();
    let report = composite_tile(
        &frames,
        &full_dims,
        &[],
        &poses(),
        None,
        &canvas,
        None,
        lenses,
        &GainOptions::default(),
        Some(1),
        &mut collector,
    )
    .expect("composite");
    let out = collector.into_image();
    let cw = canvas.width as usize;
    let ratios: Vec<f64> = (0..out.pixel_count())
        .filter(|i| out.validity.get((i % cw) as u32, (i / cw) as u32))
        .map(|i| {
            let (cx, cy) = ((i % cw) as f64 + 0.5, (i / cw) as f64 + 0.5);
            out.r[i] as f64 / scene(cx, cy) as f64
        })
        .collect();
    let max = ratios.iter().cloned().fold(f64::MIN, f64::max);
    let min = ratios.iter().cloned().fold(f64::MAX, f64::min);
    (max / min, report.falloff)
}

#[test]
fn tile_planted_vignette_is_recovered_and_flattened() {
    let (before, none) = ripple(
        planted(PLANTED_Q),
        &LensGroups::ingest_corrected(MULS.len()),
    );
    assert!(none.is_empty());
    let (after, falloff) = ripple(planted(PLANTED_Q), &one_lens());
    let q = falloff[0].q as f64;
    assert!((q - PLANTED_Q).abs() < 0.01, "q = {q}");
    assert!(falloff[0].estimable, "{:?}", falloff[0]);
    assert_eq!(falloff[0].frames, (0..MULS.len()).collect::<Vec<_>>());
    assert!(before > 1.3, "uncorrected ripple only {before}");
    assert!(
        after < 1.03,
        "ripple after correction {after} (before {before})"
    );
}

#[test]
fn tile_vignette_free_set_estimates_zero() {
    let (_, falloff) = ripple(planted(0.0), &one_lens());
    let q = falloff[0].q;
    assert!(q < 0.005, "q = {q} on a vignette-free set");
}

#[test]
fn tile_ingest_corrected_set_is_bit_identical() {
    let lenses = LensGroups::ingest_corrected(MULS.len());
    let full_dims = vec![FRAME; MULS.len()];
    let run = |lenses: &LensGroups| {
        let planted = planted(0.0);
        let frames = InMemory(&planted);
        let mut collector = CanvasCollector::default();
        composite_tile(
            &frames,
            &full_dims,
            &[],
            &poses(),
            None,
            &canvas(),
            None,
            lenses,
            &GainOptions::default(),
            Some(1),
            &mut collector,
        )
        .expect("composite");
        collector.into_image()
    };
    let corrected = run(&lenses);
    let unknown_frames = run(&LensGroups {
        labels: vec![],
        of_frame: vec![],
    });
    assert_eq!(corrected.r, unknown_frames.r);
    assert_eq!(corrected.g, unknown_frames.g);
}
