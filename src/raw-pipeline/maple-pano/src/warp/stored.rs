//! [`super::warp_to_canvas`] for a frame in a frame store (#5566): the
//! canvas is warped in strips of [`STRIP_ROWS`] rows through
//! [`super::warp_window_to_canvas_strip`], so only the source rows one strip
//! taps are resident, and each strip is copied into the canvas image as it
//! is produced.

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::frame_store::FrameRows;
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;

use super::warp_window_to_canvas_strip;

/// Canvas rows warped from one source window.
const STRIP_ROWS: u32 = 32;

/// Frame `idx` of `frames` warped onto the whole of `canvas`, bit-identical
/// to [`super::warp_to_canvas`] of the whole frame.
pub(crate) fn warp_stored_to_canvas(
    frames: &dyn FrameRows,
    idx: usize,
    cam: &Camera,
    canvas: &CanvasSpec,
    photometry: FramePhotometry,
    local_align: Option<&LocalCorrection>,
) -> Result<PlanarImage, PanoError> {
    let dims = frames.frame_dims(idx)?;
    if dims != (cam.width, cam.height) {
        return Err(PanoError::InvalidOptions(format!(
            "frame {idx} is {}x{} but its camera is {}x{}",
            dims.0, dims.1, cam.width, cam.height
        )));
    }
    let n = canvas.width as usize * canvas.height as usize;
    let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    let mut validity = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for y0 in (0..canvas.height).step_by(STRIP_ROWS as usize) {
        let y1 = (y0 + STRIP_ROWS).min(canvas.height);
        let strip = warp_window_to_canvas_strip(
            cam,
            canvas,
            photometry,
            local_align,
            y0,
            y1,
            |r0, rows| frames.read_rows(idx, r0, rows),
        )?;
        let at = y0 as usize * canvas.width as usize;
        let len = strip.r.len();
        r[at..at + len].copy_from_slice(&strip.r);
        g[at..at + len].copy_from_slice(&strip.g);
        b[at..at + len].copy_from_slice(&strip.b);
        for y in 0..strip.height() {
            for x in (0..canvas.width).filter(|&x| strip.validity.get(x, y)) {
                validity.set(x, y0 + y, true);
            }
        }
    }
    Ok(PlanarImage::from_planes(
        canvas.width,
        canvas.height,
        r,
        g,
        b,
        validity,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::InMemory;
    use crate::warp::warp_to_canvas;

    fn textured(w: u32, h: u32) -> PlanarImage {
        let px = |x: u32, y: u32, k: f32| (x as f32 * 0.37 + y as f32 * 1.13 + k).sin() * 0.5 + 0.5;
        let plane = |k: f32| {
            (0..h)
                .flat_map(|y| (0..w).map(move |x| px(x, y, k)))
                .collect::<Vec<f32>>()
        };
        let mut validity = ValidityMask::new_filled(w, h, true);
        (h / 3..h / 3 + 4).for_each(|y| (w / 2..w / 2 + 7).for_each(|x| validity.set(x, y, false)));
        PlanarImage::from_planes(w, h, plane(0.0), plane(1.7), plane(3.1), validity)
    }

    /// Stacked windowed strips equal the whole-frame warp in every plane
    /// value and validity bit, with and without a local-alignment mesh.
    #[test]
    fn stored_warp_matches_whole_frame_warp() {
        let frames = [textured(96, 72)];
        let gain = FramePhotometry {
            gain: [1.1, 0.9, 1.05],
            bias: [0.002, -0.001, 0.0],
            falloff_q: 0.3,
        };
        let canvas = CanvasSpec::full_sphere(150).unwrap();
        let mesh = LocalCorrection::identity(96.0, 72.0);
        let mesh = LocalCorrection {
            nodes: (0..mesh.nodes.len())
                .map(|k| {
                    [
                        ((k * 7 % 5) as f64 - 2.0) * 0.6,
                        ((k * 3 % 4) as f64 - 1.5) * 0.5,
                    ]
                })
                .collect(),
            max_correction_px: 1.7,
            ..mesh
        };
        for rotation in [[0.2, -0.1, 0.05], [0.0, 1.2, -0.4], [2.9, 0.3, 0.7]] {
            let cam = Camera::new(rotation, 120.0, -0.08, 0.01, 96, 72);
            for local_align in [None, Some(&mesh)] {
                let want = warp_to_canvas(&frames[0], &cam, &canvas, gain, local_align);
                let got =
                    warp_stored_to_canvas(&InMemory(&frames), 0, &cam, &canvas, gain, local_align)
                        .unwrap();
                let strips_touched: std::collections::BTreeSet<u32> = (0..canvas.height)
                    .filter(|&y| (0..canvas.width).any(|x| want.validity.get(x, y)))
                    .map(|y| y / STRIP_ROWS)
                    .collect();
                assert!(
                    strips_touched.len() >= 2,
                    "{rotation:?}: footprint must cross a strip boundary"
                );
                assert_eq!(
                    (&got.r, &got.g, &got.b),
                    (&want.r, &want.g, &want.b),
                    "{rotation:?}"
                );
                assert_eq!(got.validity, want.validity, "{rotation:?}");
            }
        }
    }

    /// A stored frame whose size disagrees with its camera is an error, not
    /// a warp with the wrong stride.
    #[test]
    fn stored_warp_rejects_a_frame_of_the_wrong_size() {
        let frames = [textured(96, 72)];
        let cam = Camera::new([0.0, 0.0, 0.0], 120.0, 0.0, 0.0, 96, 80);
        let canvas = CanvasSpec::full_sphere(150).unwrap();
        let err = warp_stored_to_canvas(
            &InMemory(&frames),
            0,
            &cam,
            &canvas,
            FramePhotometry::default(),
            None,
        );
        assert!(matches!(err, Err(PanoError::InvalidOptions(_))));
    }
}
