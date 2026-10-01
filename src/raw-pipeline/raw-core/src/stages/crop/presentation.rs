//! The existing crop renderer's rounded rectangle and rotation for GPU presentation.
use super::{needs_apply, rect_in_pixels, snap_orthogonal, OrthogonalSnap};
use crate::types::Crop;

#[derive(Clone, Copy, Debug)]
pub struct CropPresentation {
    pub output_size: [u32; 2],
    /// Integer destination pixel indices to pre-crop indices, for exact orthogonal moves.
    pub rows: [[f32; 4]; 2],
    /// Free rotation: rect origin followed by cos(-angle), sin(-angle).
    pub rotation: [f32; 4],
    pub bilinear: bool,
}

impl CropPresentation {
    pub fn new(crop: &Crop, width: u32, height: u32) -> Self {
        let effective = if needs_apply(crop) {
            *crop
        } else {
            Crop::IDENTITY
        };
        let (x, y, w, h) = rect_in_pixels(&effective, width, height);
        let snap = snap_orthogonal(effective.angle);
        let (size, rows) = match snap {
            OrthogonalSnap::Cw90 => (
                [h, w],
                [[0., 1., x as f32, 0.], [-1., 0., (y + h - 1) as f32, 0.]],
            ),
            OrthogonalSnap::Cw180 => (
                [w, h],
                [
                    [-1., 0., (x + w - 1) as f32, 0.],
                    [0., -1., (y + h - 1) as f32, 0.],
                ],
            ),
            OrthogonalSnap::Cw270 => (
                [h, w],
                [[0., -1., (x + w - 1) as f32, 0.], [1., 0., y as f32, 0.]],
            ),
            _ => ([w, h], [[1., 0., x as f32, 0.], [0., 1., y as f32, 0.]]),
        };
        let theta = -effective.angle.to_radians();
        Self {
            output_size: size,
            rows,
            rotation: [x as f32, y as f32, theta.cos(), theta.sin()],
            bilinear: snap == OrthogonalSnap::Off,
        }
    }
}
