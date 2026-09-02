//! Orchestrates the graph-cut seam computation (#1179): builds a cheap
//! downsampled "seam canvas", warps every frame onto it once, runs the
//! n-way label solve ([`super::labels`]), and exposes the result as
//! [`SeamMasks`] — per-frame weight planes the full-resolution composite
//! paths sample from by bilinear upsampling.
//!
//! # Why a separate low-resolution pass
//!
//! The memory-bounded tiled composite (`composite::composite_tiled`)
//! never holds more than one full-resolution decoded frame at a time —
//! that's the whole point of #1254. Content-aware seam finding needs at
//! least two overlapping frames' actual pixels in memory together, so it
//! can't run inside that per-tile, per-frame streaming loop without
//! breaking the memory bound.
//!
//! The fix both this crate's tiled architecture and the ticket's own
//! scope ("graph-cut seams on downsampled overlaps, <= ~2MP") point at:
//! do the content-aware work **once**, at a resolution cheap enough that
//! holding every frame's warped layer at once is fine, then hand the
//! full-resolution pass a lookup it can sample per pixel instead of
//! per-frame pixel data. [`SeamMasks::weight`] is that lookup — it keeps
//! only `k` seam-canvas-sized planes resident (a few MB total even at
//! `k` = 21), never a full-canvas-sized mask per frame.
//!
//! [`CanvasSpec::downscaled`] builds the seam canvas: same projection and
//! covered angular window as the real canvas, just fewer pixels, so a
//! seam-canvas pixel and a full-canvas pixel differ only by a fixed
//! linear scale — no re-projection needed to map between them (see
//! [`SeamMasks::weight`]).

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::ingest::{ingest_file, PlanarImage};
use crate::local_align::LocalCorrection;
use crate::warp::warp_to_canvas;

use super::labels;

/// Total pixel cap for the seam canvas ("downsampled overlaps, <= ~2MP"
/// per the ticket). The cap bounds the *whole* seam canvas, of which any
/// one pairwise overlap is a fraction, so 1MP keeps every real pairwise
/// BK graph well under the ~2MP ticket figure with headroom — measured
/// down from an initial 4MP after a real 6-frame pano_01 overlap's BK
/// solve took minutes even with [`crate::seam::pairwise`]'s iteration
/// cap in place; smaller graphs both hit that cap less often and explore
/// more of the graph per iteration when they do.
pub const SEAM_CANVAS_MAX_PX: usize = 1_000_000;

/// Feather radius in seam-canvas pixels applied to the hard label masks
/// before upsampling — the "one blend-band feather" the ticket calls
/// for, so the seam isn't a one-pixel knife edge in the final composite.
pub const FEATHER_RADIUS_PX: u32 = 3;

/// Per-frame graph-cut seam weights, computed once at [`SEAM_CANVAS_MAX_PX`]
/// resolution and sampled (bilinearly) at full-canvas coordinates on
/// demand. See the module doc for why this indirection exists.
pub struct SeamMasks {
    seam_width: u32,
    seam_height: u32,
    /// `masks[i]` is frame `i`'s feathered weight plane, length
    /// `seam_width * seam_height`.
    masks: Vec<Vec<f32>>,
    /// Full-canvas-pixel -> seam-canvas-pixel scale (see module doc:
    /// `downscaled` keeps the same angular window, so this is a fixed
    /// ratio, not a reprojection).
    scale_x: f64,
    scale_y: f64,
}

impl SeamMasks {
    /// Frame `i`'s blend weight at full-canvas continuous pixel
    /// `(fx, fy)`. `0.0` for an out-of-range frame index or a position
    /// that maps entirely off the seam canvas.
    pub fn weight(&self, i: usize, fx: f64, fy: f64) -> f32 {
        let Some(plane) = self.masks.get(i) else {
            return 0.0;
        };
        sample_bilinear(
            plane,
            self.seam_width,
            self.seam_height,
            fx * self.scale_x,
            fy * self.scale_y,
        )
    }
}

/// Bilinear sample of a row-major `w * h` plane at continuous pixel
/// coordinates, clamped to the plane's bounds (no extrapolation past the
/// border — the seam canvas has no validity concept once masks are
/// built, so clamping is the correct "nearest sensible answer").
fn sample_bilinear(plane: &[f32], w: u32, h: u32, x: f64, y: f64) -> f32 {
    if w == 0 || h == 0 {
        return 0.0;
    }
    let x = (x - 0.5).clamp(0.0, w as f64 - 1.0);
    let y = (y - 0.5).clamp(0.0, h as f64 - 1.0);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(w as usize - 1);
    let y1 = (y0 + 1).min(h as usize - 1);
    let tx = (x - x0 as f64) as f32;
    let ty = (y - y0 as f64) as f32;
    let at = |xx: usize, yy: usize| plane[yy * (w as usize) + xx];
    let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
    let bot = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
    top * (1.0 - ty) + bot * ty
}

/// Shared tail: run the n-way label solve over already-warped
/// seam-canvas layers, feather, and package as [`SeamMasks`].
fn finish(
    layers: Vec<PlanarImage>,
    seam_canvas: &CanvasSpec,
    full_canvas: &CanvasSpec,
) -> SeamMasks {
    let (sw, sh) = (seam_canvas.width, seam_canvas.height);
    let labels = labels::compute_labels(&layers);
    let mut masks = labels::labels_to_masks(&labels, layers.len());
    labels::feather_masks(&mut masks, sw, sh, FEATHER_RADIUS_PX);
    SeamMasks {
        seam_width: sw,
        seam_height: sh,
        masks,
        scale_x: sw as f64 / full_canvas.width as f64,
        scale_y: sh as f64 / full_canvas.height as f64,
    }
}

/// Build [`SeamMasks`] by decoding each source frame from disk, warping
/// it onto the (small) seam canvas, and freeing the full-resolution
/// pixels before moving to the next frame — the same "decode, use,
/// drop" discipline `composite::composite_tiled` uses for the
/// full-resolution pass, just applied to a canvas cheap enough to hold
/// every frame's result at once.
pub fn build_from_paths(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    full_canvas: &CanvasSpec,
) -> Result<SeamMasks, PanoError> {
    if paths.len() != cameras.len() || paths.len() != gains.len() {
        return Err(PanoError::InvalidOptions(format!(
            "seam::masks::build_from_paths: {} paths, {} cameras, {} gains",
            paths.len(),
            cameras.len(),
            gains.len(),
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != paths.len() {
        return Err(PanoError::InvalidOptions(format!(
            "seam::masks::build_from_paths: {} local corrections vs {} paths (pass an empty slice to skip alignment)",
            local_corrections.len(),
            paths.len()
        )));
    }
    let seam_canvas = full_canvas.downscaled(SEAM_CANVAS_MAX_PX);
    let mut layers = Vec::with_capacity(paths.len());
    for (i, (path, cam)) in paths.iter().zip(cameras).enumerate() {
        let frame = ingest_file(path)?;
        let la = local_corrections.get(i).and_then(|o| o.as_ref());
        let gain = gains.get(i).copied().unwrap_or([1.0, 1.0, 1.0]);
        layers.push(warp_to_canvas(&frame.image, cam, &seam_canvas, gain, la));
        // frame drops here — full-resolution pixels never accumulate.
    }
    Ok(finish(layers, &seam_canvas, full_canvas))
}

/// Same as [`build_from_paths`] but for already-decoded frames (tests,
/// and callers that decoded for another purpose and kept the pixels —
/// mirrors `composite::composite_tiled_frames`).
pub fn build_from_frames(
    frames: &[PlanarImage],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    full_canvas: &CanvasSpec,
) -> SeamMasks {
    assert_eq!(
        frames.len(),
        cameras.len(),
        "seam::masks::build_from_frames: frame/camera count mismatch"
    );
    assert_eq!(
        frames.len(),
        gains.len(),
        "seam::masks::build_from_frames: frame/gain count mismatch"
    );
    assert!(
        local_corrections.is_empty() || local_corrections.len() == frames.len(),
        "seam::masks::build_from_frames: {} local corrections vs {} frames (pass an empty slice to skip alignment)",
        local_corrections.len(),
        frames.len()
    );
    let seam_canvas = full_canvas.downscaled(SEAM_CANVAS_MAX_PX);
    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(cameras)
        .enumerate()
        .map(|(i, (f, cam))| {
            let la = local_corrections.get(i).and_then(|o| o.as_ref());
            let gain = gains.get(i).copied().unwrap_or([1.0, 1.0, 1.0]);
            warp_to_canvas(f, cam, &seam_canvas, gain, la)
        })
        .collect();
    finish(layers, &seam_canvas, full_canvas)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;
    use crate::math::Vec3;
    use crate::prng::SplitMix64;
    use crate::render::{build_camera_set, CameraSetOptions, Pattern};

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
            width: 48,
            height: 36,
        };
        build_camera_set(&opts, &mut SplitMix64::new(11))
            .expect("valid ring")
            .iter()
            .map(|c| c.to_camera())
            .collect()
    }

    fn scene(dir: Vec3) -> [f32; 3] {
        let v = (0.5 + 0.3 * (2.0 * dir.x).sin()) as f32;
        [v, v * 0.9, v * 0.8]
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

    #[test]
    fn weights_sum_to_roughly_one_where_any_frame_is_covered() {
        let cams = ring_cameras(3);
        let frames: Vec<PlanarImage> = cams.iter().map(frame_from_scene).collect();
        let canvas = crate::canvas::auto_canvas(&cams, &crate::canvas::CanvasOptions::default())
            .expect("canvas");
        let gains = vec![[1.0, 1.0, 1.0]; cams.len()];
        let no_lc: Vec<Option<LocalCorrection>> = vec![None; cams.len()];
        let seam = build_from_frames(&frames, &cams, &gains, &no_lc, &canvas);

        // Sample a grid of full-canvas points. Total weight across frames
        // must never exceed ~1 (feathering only softens a boundary, never
        // creates over-coverage), and well inside a single frame's
        // footprint (away from any seam or validity edge) it should sit
        // close to 1.0 — the un-feathered plateau of that frame's mask.
        let mut max_total_seen = 0.0_f32;
        for y in (0..canvas.height).step_by(5) {
            for x in (0..canvas.width).step_by(5) {
                let total: f32 = (0..cams.len())
                    .map(|i| seam.weight(i, x as f64 + 0.5, y as f64 + 0.5))
                    .sum();
                max_total_seen = max_total_seen.max(total);
                assert!(
                    total <= 1.05,
                    "total weight {total} at ({x},{y}) exceeds partition-of-unity"
                );
            }
        }
        assert!(
            max_total_seen > 0.9,
            "expected at least one sample deep inside a frame's footprint \
             (total weight near 1.0), max seen was {max_total_seen}"
        );
    }

    /// A `local_corrections` slice that is neither empty nor exactly
    /// per-frame must be rejected explicitly, not silently truncated by
    /// `.get(i)` inside the warp loop (which would leave later frames'
    /// alignment corrections quietly dropped). The mismatch is caught
    /// before any file I/O, so nonexistent paths are fine here.
    #[test]
    fn build_from_paths_rejects_mismatched_local_corrections() {
        let cams = ring_cameras(2);
        let paths = vec![
            std::path::PathBuf::from("/nonexistent/a.dng"),
            std::path::PathBuf::from("/nonexistent/b.dng"),
        ];
        let gains = vec![[1.0, 1.0, 1.0]; cams.len()];
        let canvas = crate::canvas::auto_canvas(&cams, &crate::canvas::CanvasOptions::default())
            .expect("canvas");
        // One entry for two frames: neither empty nor exactly per-frame.
        let short_lc: Vec<Option<LocalCorrection>> = vec![None];

        let result = build_from_paths(&paths, &cams, &gains, &short_lc, &canvas);
        assert!(
            result.is_err(),
            "expected a length-mismatch error, got Ok (silently truncated)"
        );
    }

    /// Same contract as [`build_from_paths_rejects_mismatched_local_corrections`]
    /// for the pre-loaded-frames entry point — infallible, so the contract
    /// is a panic instead of a `Result::Err`.
    #[test]
    #[should_panic(expected = "local corrections")]
    fn build_from_frames_rejects_mismatched_local_corrections() {
        let cams = ring_cameras(2);
        let frames: Vec<PlanarImage> = cams.iter().map(frame_from_scene).collect();
        let gains = vec![[1.0, 1.0, 1.0]; cams.len()];
        let canvas = crate::canvas::auto_canvas(&cams, &crate::canvas::CanvasOptions::default())
            .expect("canvas");
        // One entry for two frames: neither empty nor exactly per-frame.
        let short_lc: Vec<Option<LocalCorrection>> = vec![None];

        build_from_frames(&frames, &cams, &gains, &short_lc, &canvas);
    }
}
