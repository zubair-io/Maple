//! Unit tests for [`crate::tile`] compositing — the spatial-culling
//! invariant, seam placement, and the canvas pixel cap (#3086).
//! Kept in a separate file for the file-size budget.

use super::frame_cache::TileFrameCache;
use super::masks::voronoi_masks_region;
use super::photometry;
use super::*;
use crate::blend::blend_multiband;
use crate::gain::GainOptions;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::similarity::Similarity2d;

/// Frame whose content is a linear function of CANVAS position (under a
/// pure-translation pose), so bicubic resampling reproduces it exactly,
/// overlapping frames agree in their overlap (gains solve to exactly 1),
/// and any misplacement shows up as a value error.
fn canvas_gradient_frame(w: u32, h: u32, tx: f64, ty: f64) -> PlanarImage {
    let n = (w * h) as usize;
    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let b = vec![0.3_f32; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            r[i] = ((x as f64 + tx) / 1000.0) as f32;
            g[i] = ((y as f64 + ty) / 1000.0) as f32;
        }
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

fn translation_pose(frame_idx: usize, tx: f64, ty: f64) -> TilePose {
    TilePose {
        frame_idx,
        sim: Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx,
            ty,
        },
    }
}

/// The exact invariant the per-tile frame culling rests on: a layer with
/// no valid pixel in the region contributes nothing to the Voronoi masks
/// or the multiband blend — removing it is bit-identical (#3086).
#[test]
fn all_invalid_layer_is_inert_in_masks_and_blend() {
    let (w, h) = (96u32, 64u32);
    let poses = [
        translation_pose(0, 0.0, 0.0),
        translation_pose(1, 40.0, 0.0),
        translation_pose(2, 5000.0, 5000.0), // far outside the region
    ];
    let canvas = TileCanvasSpec {
        width: w + 48,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };
    let frames = [
        canvas_gradient_frame(w, h, 0.0, 0.0),
        canvas_gradient_frame(w, h, 40.0, 0.0),
        canvas_gradient_frame(w, h, 5000.0, 5000.0),
    ];
    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(&poses)
        .map(|(f, p)| {
            warp::warp_to_tile_region(
                f,
                p,
                &canvas,
                &photometry::FramePhotometry::neutral(),
                0,
                0,
                canvas.width as usize,
                canvas.height as usize,
            )
        })
        .collect();
    assert!(
        !layers[2].validity.any_valid(),
        "far layer must be all-invalid in this region"
    );

    let frame_dims = [(w, h); 3];
    let (masks_all, _) = voronoi_masks_region(&layers, &poses, &frame_dims, &canvas, 0, 0);
    let (masks_two, _) =
        voronoi_masks_region(&layers[..2], &poses[..2], &frame_dims[..2], &canvas, 0, 0);
    assert!(
        masks_all[2].iter().all(|&m| m == 0.0),
        "all-invalid layer must own no pixels"
    );
    assert_eq!(masks_all[0], masks_two[0], "mask 0 must be unaffected");
    assert_eq!(masks_all[1], masks_two[1], "mask 1 must be unaffected");

    let blended_all = blend_multiband(&layers, &masks_all, 2);
    let blended_two = blend_multiband(&layers[..2], &masks_two, 2);
    assert_eq!(blended_all.r, blended_two.r, "R must be bit-identical");
    assert_eq!(blended_all.g, blended_two.g, "G must be bit-identical");
    assert_eq!(blended_all.b, blended_two.b, "B must be bit-identical");
}

/// Voronoi seams must sit mid-overlap (equidistant from the two frames'
/// source borders), not on the leading frame's validity edge (#3086).
/// Frame 0 spans canvas x ∈ [0, 64), frame 1 spans [40, 104): the
/// overlap is [40, 64) with midpoint 52.
#[test]
fn voronoi_seam_sits_mid_overlap() {
    let (w, h) = (64u32, 48u32);
    let poses = [
        translation_pose(0, 0.0, 0.0),
        translation_pose(1, 40.0, 0.0),
    ];
    let canvas = TileCanvasSpec {
        width: 104,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };
    let frames = [
        canvas_gradient_frame(w, h, 0.0, 0.0),
        canvas_gradient_frame(w, h, 40.0, 0.0),
    ];
    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(&poses)
        .map(|(f, p)| {
            warp::warp_to_tile_region(
                f,
                p,
                &canvas,
                &photometry::FramePhotometry::neutral(),
                0,
                0,
                canvas.width as usize,
                canvas.height as usize,
            )
        })
        .collect();
    let frame_dims = [(w, h); 2];
    let (masks, _) = voronoi_masks_region(&layers, &poses, &frame_dims, &canvas, 0, 0);

    let cw = canvas.width as usize;
    let y = (h / 2) as usize;
    // Well inside frame 0's half of the overlap → frame 0 owns it.
    assert_eq!(masks[0][y * cw + 45], 1.0, "x=45 must belong to frame 0");
    assert_eq!(masks[1][y * cw + 45], 0.0);
    // Well inside frame 1's half of the overlap → frame 1 owns it.
    assert_eq!(masks[1][y * cw + 59], 1.0, "x=59 must belong to frame 1");
    assert_eq!(masks[0][y * cw + 59], 0.0);
}

/// End-to-end: a composite spanning several tiles with a far-away frame
/// must place every frame's content correctly (guards the culling path
/// against dropped or mis-indexed frames/gains).
#[test]
fn composite_with_far_frame_places_all_content() {
    let (fw, fh) = (64u32, 64u32);
    let poses = vec![
        translation_pose(0, 0.0, 0.0),
        translation_pose(1, 40.0, 0.0),
        translation_pose(2, 2000.0, 2000.0),
    ];
    let frames = vec![
        canvas_gradient_frame(fw, fh, 0.0, 0.0),
        canvas_gradient_frame(fw, fh, 40.0, 0.0),
        canvas_gradient_frame(fw, fh, 2000.0, 2000.0),
    ];
    let canvas = TileCanvasSpec {
        width: 2080,
        height: 2080,
        offset_x: 8.0,
        offset_y: 8.0,
    };
    // #3197: composite_tile decodes on demand through a cache instead of
    // taking a pre-decoded frame slice — TileFrameCache::from_frames
    // (test-only) seeds it with these synthetic frames.
    let full_dims: Vec<(u32, u32)> = frames.iter().map(|f| (f.width(), f.height())).collect();
    let cache = TileFrameCache::from_frames(frames);
    let (out, _report) = composite_tile(
        &cache,
        &full_dims,
        &[],
        &poses,
        &canvas,
        &GainOptions::default(),
        Some(2),
    )
    .expect("composite");

    let cw = out.width() as usize;
    // Content is the canvas-space gradient, so expected value at canvas
    // (cx, cy) is ((cx − offset)/1000, (cy − offset)/1000) wherever a
    // frame covers it.
    for &(cx, cy) in &[(20usize, 20usize), (60, 30), (2030, 2030)] {
        assert!(
            out.validity.get(cx as u32, cy as u32),
            "({cx},{cy}) must be covered"
        );
        let want_r = (cx as f64 - 8.0 + 0.5) / 1000.0;
        let want_g = (cy as f64 - 8.0 + 0.5) / 1000.0;
        let i = cy * cw + cx;
        assert!(
            (out.r[i] as f64 - want_r).abs() < 2e-3 && (out.g[i] as f64 - want_g).abs() < 2e-3,
            "content off at ({cx},{cy}): got ({}, {}), want ({want_r:.4}, {want_g:.4})",
            out.r[i],
            out.g[i]
        );
    }
    // The gap between the strip and the far frame stays invalid.
    assert!(!out.validity.get(1000, 1000), "gap must be uncovered");
}

/// `apply_canvas_cap` scales poses + canvas uniformly to fit the pixel
/// budget and is a no-op when already within it.
#[test]
fn canvas_cap_scales_poses_and_canvas_uniformly() {
    let poses = vec![
        translation_pose(0, 0.0, 0.0),
        translation_pose(1, 1000.0, 500.0),
    ];
    let canvas = TileCanvasSpec {
        width: 2000,
        height: 1000,
        offset_x: 8.0,
        offset_y: 8.0,
    };

    // Within budget: untouched.
    let (p_same, c_same) = apply_canvas_cap(poses.clone(), canvas.clone(), 4_000_000).unwrap();
    assert_eq!(c_same.width, 2000);
    assert_eq!(c_same.height, 1000);
    assert_eq!(p_same[1].sim.tx, 1000.0);

    // Over budget: uniform downscale to fit.
    let cap = 500_000usize;
    let (p_cap, c_cap) = apply_canvas_cap(poses.clone(), canvas.clone(), cap).unwrap();
    let px = c_cap.width as usize * c_cap.height as usize;
    assert!(px <= cap, "capped canvas {px} px > cap {cap}");
    let s = (cap as f64 / 2_000_000.0).sqrt();
    assert!(
        (c_cap.width as f64 - 2000.0 * s).abs() <= 1.0,
        "width {} vs expected {}",
        c_cap.width,
        2000.0 * s
    );

    // A source point maps to s × its original canvas position (offsets
    // included), so geometry is preserved under the downscale.
    for (orig, capped) in poses.iter().zip(&p_cap) {
        let (ox, oy) = orig.sim.apply(32.0, 48.0);
        let (nx, ny) = capped.sim.apply(32.0, 48.0);
        let (ox, oy) = (ox + canvas.offset_x, oy + canvas.offset_y);
        let (nx, ny) = (nx + c_cap.offset_x, ny + c_cap.offset_y);
        assert!(
            (nx - ox * s).abs() < 1e-6 && (ny - oy * s).abs() < 1e-6,
            "capped mapping ({nx},{ny}) != s×({ox},{oy})"
        );
    }

    // A zero cap is rejected, not silently collapsed to a 1x1 canvas -
    // same contract as the rotation path's auto_canvas.
    assert!(matches!(
        apply_canvas_cap(poses, canvas, 0),
        Err(TilePlacementError::InvalidCanvasCap)
    ));
}
