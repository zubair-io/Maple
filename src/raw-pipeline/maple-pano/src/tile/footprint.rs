//! The tile canvas's footprint from geometry alone, for Boundary Warp
//! (#5572).

use crate::boundary_warp::Footprint;
use crate::local_align::LocalCorrection;

use super::placement::{TileCanvasSpec, TilePose};
use super::warp::inverse_similarity_with_offset;

/// Which pixels of a copy of `canvas` at most `max_px` pixels some frame
/// covers: a pixel is covered when a pose, after its Stage-F correction,
/// maps its centre inside the frame. `full_dims` is indexed by frame index,
/// `corrections` parallel to `poses`.
pub(crate) fn tile_footprint(
    poses: &[TilePose],
    full_dims: &[(u32, u32)],
    corrections: Option<&[LocalCorrection]>,
    canvas: &TileCanvasSpec,
    max_px: usize,
) -> Footprint {
    let (cw, ch) = (canvas.width as f64, canvas.height as f64);
    let scale = (max_px as f64 / (cw * ch)).sqrt().min(1.0);
    let (pw, ph) = (
        ((cw * scale).round() as u32).max(1),
        ((ch * scale).round() as u32).max(1),
    );
    let frames: Vec<_> = poses
        .iter()
        .enumerate()
        .map(|(i, pose)| {
            let (fw, fh) = full_dims[pose.frame_idx];
            (
                inverse_similarity_with_offset(&pose.sim, canvas.offset_x, canvas.offset_y),
                corrections.map(|c| &c[i]),
                (fw as f64, fh as f64),
            )
        })
        .collect();
    Footprint::from_fn(pw, ph, false, |x, y| {
        let (cx, cy) = (
            (x as f64 + 0.5) * cw / pw as f64,
            (y as f64 + 0.5) * ch / ph as f64,
        );
        frames.iter().any(|(inv, local, (fw, fh))| {
            let (px, py) = inv.apply(cx, cy);
            let (fx, fy) = local.map_or((px, py), |c| c.apply(px, py));
            (0.0..=*fw).contains(&fx) && (0.0..=*fh).contains(&fy)
        })
    })
}
