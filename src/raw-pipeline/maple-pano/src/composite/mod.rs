//! The M2-CPU compositing orchestrator (spec §5.4–§5.8): canvas →
//! gain → warp → seam placement → multi-band blend.
//!
//! # Seam placement
//!
//! [`CompositeOptions::seam_strategy`] picks between two seam placements
//! (`crate::seam::SeamStrategy`):
//!
//! - **Voronoi** (default, M2a): each covered canvas pixel is owned by
//!   the frame whose projection of it sits deepest inside that frame
//!   (max distance to its nearest frame edge) — the classic
//!   Burt–Adelson composite, deterministic and content-blind.
//! - **GraphCut** (M2b, #1179): a Boykov–Kolmogorov max-flow seam
//!   (`crate::seam`) that routes the boundary around content only one
//!   frame shows (a moving subject, a parallax-shifted edge) instead of
//!   cutting through it — computed on a cheap downsampled "seam canvas"
//!   (`crate::seam::masks`) and sampled back at full resolution.
//!
//! [`CompositeReport::seam_strategy`] records which one a given run
//! actually used, and both `maple-cli pano stitch`'s report JSON and the
//! `StitchReport` surface it (spec §6).
//!
//! # Memory-bounded tiled path (`composite_tiled`, M6-D #1248)
//!
//! [`composite_tiled`] accepts already-solved photometry and a `tile_rows` height
//! for the strip decomposition. It decodes source frames on demand (one at a
//! time) using the supplied file paths, warping each frame into one strip's
//! blend window and freeing the decoded pixels before moving to the next
//! frame. Each strip is multi-band blended inside a window widened by the
//! pyramid's reach (#4524), so the assembled canvas equals [`composite`]'s
//! whole-canvas [`blend_multiband`] at the same band count for any
//! `tile_rows`, while blend memory stays bounded by the window.
//!
//! Measured peak RSS on pano_01 (21 DJI DNGs, proxy_long_edge=1600,
//! canvas_tile_rows=512): **17.83 GB** — dominated by the full-resolution
//! refinement phase holding all decoded frames simultaneously before gains are
//! solved (the `kept_frames_for_gain` clone in `stitch.rs` and the depths
//! `Vec<Vec<f32>>` per frame are the primary drivers). The per-tile composite
//! strip allocation itself is small, but it doesn't help while all frames are
//! still resident. The real memory work — restructuring `depths: Vec<Vec<f32>>`,
//! eliminating `kept_frames_for_gain` full-res clones, and streaming the
//! refinement phase — is tracked in #1254.

mod tiled;

pub use tiled::{composite_tiled, composite_tiled_frames};

use rayon::prelude::*;

use crate::blend::{blend_multiband, levels_for_overlap_width};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions, CanvasSpec};
use crate::error::PanoError;
use crate::gain::{solve_photometry, FramePhotometry, GainOptions};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::project::Projection;
use crate::seam::{self, SeamStrategy};
use crate::warp::warp_to_canvas;

/// Options for [`composite`].
#[derive(Debug, Clone, Default)]
pub struct CompositeOptions {
    pub canvas: CanvasOptions,
    pub gain: GainOptions,
    /// Override the spec band-count rule (`log2(min overlap width)`,
    /// cap 7). Mostly for tests.
    pub levels_override: Option<usize>,
    /// Voronoi (default) or graph-cut seam placement (#1179). See the
    /// module doc.
    pub seam_strategy: SeamStrategy,
}

/// What [`composite`] did — the numbers the CLI report surfaces.
#[derive(Debug, Clone)]
pub struct CompositeReport {
    pub canvas: CanvasSpec,
    pub projection: Projection,
    pub photometry: Vec<FramePhotometry>,
    pub blend_levels: usize,
    /// Average overlap width (px) of the narrowest overlapping pair —
    /// the input to the band-count rule.
    pub min_overlap_width_px: usize,
    /// Which seam placement this run actually used (#1179).
    pub seam_strategy: SeamStrategy,
}

/// Composite posed frames onto an automatically constructed canvas.
///
/// `frames[i]` corresponds to `cameras[i]` (the BA output poses with
/// per-frame focals where freed). Frames whose camera is `None` in the
/// caller's bookkeeping should simply not be passed in.
///
/// `local_corrections`: optional per-frame stage-F alignment corrections
/// (#1218, spec §8).  When present, `local_corrections[i]` is applied to
/// `frames[i]` in a single resample — no extra pass.  Pass an empty slice
/// or a slice of `None`s to skip alignment.
pub fn composite(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &CompositeOptions,
    local_corrections: &[Option<LocalCorrection>],
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if frames.len() != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite: {} frames vs {} cameras",
            frames.len(),
            cameras.len()
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != frames.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite: {} local corrections vs {} frames (pass an empty              slice to skip alignment)",
            local_corrections.len(),
            frames.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite: no frames to composite".into(),
        ));
    }

    let canvas = auto_canvas(cameras, &opts.canvas)?;
    let photometry = solve_photometry(frames, cameras, &opts.gain)?;

    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(cameras)
        .zip(&photometry)
        .enumerate()
        .map(|(i, ((f, c), &g))| {
            let la = local_corrections.get(i).and_then(|opt| opt.as_ref());
            warp_to_canvas(f, c, &canvas, g, la)
        })
        .collect();

    let (voronoi, min_overlap) = voronoi_masks(&layers, cameras, &canvas);
    let masks = match opts.seam_strategy {
        SeamStrategy::Voronoi => voronoi,
        SeamStrategy::GraphCut => {
            // All layers are already resident at full canvas resolution
            // here (unlike the memory-bounded tiled path), so the label
            // solve runs directly on them — no downsampled seam canvas
            // needed for this entry point.
            let labels = seam::labels::compute_labels(&layers);
            let mut masks = seam::labels::labels_to_masks(&labels, layers.len());
            seam::labels::feather_masks(
                &mut masks,
                canvas.width,
                canvas.height,
                seam::masks::FEATHER_RADIUS_PX,
            );
            masks
        }
    };
    let levels = opts
        .levels_override
        .unwrap_or_else(|| levels_for_overlap_width(min_overlap));
    let blended = blend_multiband(&layers, &masks, levels);

    let projection = canvas.projection;
    Ok((
        blended,
        CompositeReport {
            canvas,
            projection,
            photometry,
            blend_levels: levels,
            min_overlap_width_px: min_overlap,
            seam_strategy: opts.seam_strategy,
        },
    ))
}

/// Per-frame hard ownership masks by source-border depth, plus the
/// average overlap width (px) of the narrowest overlapping pair.
///
/// Ownership score for a covered canvas pixel = how deep its projection
/// sits inside the owning frame (min distance to that frame's nearest
/// edge, in source pixels). Ties break to the lower frame index
/// (determinism).
fn voronoi_masks(
    layers: &[PlanarImage],
    cameras: &[Camera],
    canvas: &CanvasSpec,
) -> (Vec<Vec<f32>>, usize) {
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let n = cw * ch;
    let k = layers.len();

    // Depth score per frame per pixel (negative = not covered).
    let depths: Vec<Vec<f32>> = cameras
        .par_iter()
        .zip(layers.par_iter())
        .map(|(cam, layer)| {
            let mut d = vec![-1.0_f32; n];
            for (i, slot) in d.iter_mut().enumerate() {
                let (x, y) = ((i % cw) as u32, (i / cw) as u32);
                if !layer.validity.get(x, y) {
                    continue;
                }
                let Some(dir) = canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5) else {
                    continue;
                };
                let Some((sx, sy)) = cam.world_dir_to_pixel(dir) else {
                    continue;
                };
                let border = sx
                    .min(cam.width as f64 - sx)
                    .min(sy)
                    .min(cam.height as f64 - sy);
                *slot = border.max(0.0) as f32;
            }
            d
        })
        .collect();

    let mut masks = vec![vec![0.0_f32; n]; k];
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];
    for i in 0..n {
        let mut best: Option<(usize, f32)> = None;
        for (f, depth) in depths.iter().enumerate() {
            let d = depth[i];
            if d < 0.0 {
                continue;
            }
            if best.is_none_or(|(_, bd)| d > bd) {
                best = Some((f, d));
            }
        }
        if let Some((f, _)) = best {
            masks[f][i] = 1.0;
        }
        // Pairwise overlap bookkeeping (counts + distinct rows) for the
        // band rule.
        for a in 0..k {
            if depths[a][i] < 0.0 {
                continue;
            }
            for b in (a + 1)..k {
                if depths[b][i] >= 0.0 {
                    overlap_count[a][b] += 1;
                    overlap_rows[a][b].insert(i / cw);
                }
            }
        }
    }

    // Narrowest pair's average overlap width = count / distinct rows.
    let mut min_width = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows == 0 {
                continue;
            }
            min_width = min_width.min(overlap_count[a][b] / rows);
        }
    }
    if min_width == usize::MAX {
        min_width = 0; // single frame or disjoint coverage
    }
    (masks, min_width)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;
    use crate::math::Vec3;
    use crate::prng::SplitMix64;
    use crate::render::{build_camera_set, CameraSetOptions, Pattern};

    /// Smooth deterministic scene function (same as gain/tests.rs).
    fn scene(dir: Vec3) -> [f32; 3] {
        let base = 0.45 + 0.2 * (3.0 * dir.x + 1.0).sin() + 0.15 * (2.0 * dir.y - 0.5).cos();
        [
            base as f32,
            (base * 0.8 + 0.1 * (4.0 * dir.z).sin()) as f32,
            (base * 0.6 + 0.05) as f32,
        ]
    }

    fn frame_from_scene(cam: &Camera) -> PlanarImage {
        let (w, h) = (cam.width, cam.height);
        let n = (w as usize) * (h as usize);
        let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        for y in 0..h {
            for x in 0..w {
                let d = cam
                    .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                    .expect("invertible");
                let s = scene(d);
                let i = (y * w + x) as usize;
                r[i] = s[0];
                g[i] = s[1];
                b[i] = s[2];
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    fn ring_cameras(count: u32) -> Vec<Camera> {
        let opts = CameraSetOptions {
            count,
            pattern: Pattern::Ring { full: false },
            fov_deg: 60.0,
            overlap: 0.4,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 64,
            height: 48,
        };
        build_camera_set(&opts, &mut SplitMix64::new(7))
            .expect("valid ring")
            .iter()
            .map(|c| c.to_camera())
            .collect()
    }

    /// `composite_tiled_frames` must reproduce `composite` (same photometry, same
    /// automatic band count) at more than one strip height.
    #[test]
    fn composite_tiled_frames_equals_composite() {
        let cams = ring_cameras(3);
        let frames: Vec<PlanarImage> = cams.iter().map(frame_from_scene).collect();
        let no_lc: Vec<Option<crate::local_align::LocalCorrection>> = vec![None; cams.len()];

        let canvas_opts = CanvasOptions::default();
        let canvas = auto_canvas(&cams, &canvas_opts).expect("canvas");

        let ref_opts = CompositeOptions {
            canvas: canvas_opts.clone(),
            ..Default::default()
        };
        let (ref_img, ref_report) =
            composite(&frames, &cams, &ref_opts, &no_lc).expect("composite");

        let photometry = ref_report.photometry.clone();
        assert!(
            ref_report.blend_levels > 1,
            "test must exercise a real pyramid"
        );

        for strip_rows in [5_u32, 16] {
            let (tiled_img, tiled_report) = composite_tiled_frames(
                &frames,
                &cams,
                &photometry,
                &no_lc,
                &canvas,
                strip_rows,
                SeamStrategy::Voronoi,
            )
            .expect("composite_tiled_frames");
            assert_eq!(tiled_report.blend_levels, ref_report.blend_levels);

            assert_eq!(
                tiled_img.width(),
                ref_img.width(),
                "strip_rows={strip_rows}: canvas width mismatch"
            );
            assert_eq!(
                tiled_img.height(),
                ref_img.height(),
                "strip_rows={strip_rows}: canvas height mismatch"
            );

            let n = (ref_img.width() as usize) * (ref_img.height() as usize);
            let mut max_diff = 0.0_f32;
            for i in 0..n {
                let dr = (tiled_img.r[i] - ref_img.r[i]).abs();
                let dg = (tiled_img.g[i] - ref_img.g[i]).abs();
                let db = (tiled_img.b[i] - ref_img.b[i]).abs();
                max_diff = max_diff.max(dr).max(dg).max(db);

                // Validity must also match.
                let (x, y) = (
                    (i % ref_img.width() as usize) as u32,
                    (i / ref_img.width() as usize) as u32,
                );
                assert_eq!(
                    tiled_img.validity.get(x, y),
                    ref_img.validity.get(x, y),
                    "validity mismatch at ({x},{y}) strip_rows={strip_rows}"
                );
            }

            assert!(
                max_diff < 1e-6,
                "strip_rows={strip_rows}: max pixel diff = {max_diff} (expected < 1e-6); \
                 composite and composite_tiled_frames are not equivalent"
            );
        }
    }
}
