//! [`super::warp_to_canvas`] for a frame in a frame store (#5566): the
//! canvas is warped in strips of [`STRIP_ROWS`] rows through
//! [`super::warp_window_to_canvas_strip`], so only the source rows one strip
//! taps are resident, and each strip is copied into the canvas image as it
//! is produced.

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::frame_store::{FrameRows, InMemory, MipGeometry, MIP_FACTOR};
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;

use super::warp_window_to_canvas_strip;

/// Canvas rows warped from one source window.
const STRIP_ROWS: u32 = 32;

/// Frame `idx` of `frames` warped onto the whole of `canvas`. When `canvas`
/// is at least [`MIP_FACTOR`] source pixels per canvas pixel and the frames
/// keep a mip, the mip is warped instead of the full frame (#6057);
/// otherwise the result is bit-identical to [`super::warp_to_canvas`] of the
/// whole frame.
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
    let coarse = cam.focal_px / canvas.pixels_per_radian() >= MIP_FACTOR as f64;
    if let Some(mip) = coarse.then(|| frames.mip(idx)).transpose()?.flatten() {
        let mip_cam = mip_camera(cam, &mip);
        let mip_align = local_align.map(mip_correction);
        return warp_stored_to_canvas(
            &InMemory(std::slice::from_ref(&mip)),
            0,
            &mip_cam,
            canvas,
            photometry,
            mip_align.as_ref(),
        );
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

/// `cam` for its frame's mip: the same rays at 1/[`MIP_FACTOR`] the
/// focal length. The distortion is in focal-normalised coordinates and
/// carries over unchanged.
fn mip_camera(cam: &Camera, mip: &PlanarImage) -> Camera {
    debug_assert_eq!(
        MipGeometry::of(cam.width, cam.height).map(|g| (g.width, g.height)),
        Some((mip.width(), mip.height()))
    );
    Camera {
        focal_px: cam.focal_px / MIP_FACTOR as f64,
        width: mip.width(),
        height: mip.height(),
        ..cam.clone()
    }
}

fn mip_correction(la: &LocalCorrection) -> LocalCorrection {
    let s = 1.0 / MIP_FACTOR as f64;
    LocalCorrection {
        w: la.w * s,
        h: la.h * s,
        nodes: la.nodes.iter().map(|n| n.map(|d| d * s)).collect(),
        rms_px: la.rms_px * s,
        max_correction_px: la.max_correction_px * s,
        ..la.clone()
    }
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

    struct WithMip<'a> {
        frames: InMemory<'a>,
        mip: PlanarImage,
    }

    impl FrameRows for WithMip<'_> {
        fn frame_count(&self) -> usize {
            self.frames.frame_count()
        }
        fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError> {
            self.frames.frame_dims(idx)
        }
        fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError> {
            self.frames.read_rows(idx, y0, rows)
        }
        fn read_rect(
            &self,
            idx: usize,
            rect: crate::frame_store::FrameRect,
        ) -> Result<PlanarImage, PanoError> {
            self.frames.read_rect(idx, rect)
        }
        fn mip(&self, _idx: usize) -> Result<Option<PlanarImage>, PanoError> {
            Ok(Some(self.mip.clone()))
        }
    }

    fn box_mip(frame: &PlanarImage) -> PlanarImage {
        let g = MipGeometry::of(frame.width(), frame.height()).unwrap();
        let f = MIP_FACTOR;
        let (ox, oy) = ((frame.width() % f) / 2, (frame.height() % f) / 2);
        let plane = |src: &[f32]| -> Vec<f32> {
            (0..g.height)
                .flat_map(|my| (0..g.width).map(move |mx| (mx, my)))
                .map(|(mx, my)| {
                    let at = |dx: u32, dy: u32| {
                        src[((oy + my * f + dy) * frame.width() + ox + mx * f + dx) as usize]
                    };
                    (0..f)
                        .flat_map(|dy| (0..f).map(move |dx| (dx, dy)))
                        .map(|(dx, dy)| at(dx, dy))
                        .sum::<f32>()
                        / (f * f) as f32
                })
                .collect()
        };
        PlanarImage::from_planes(
            g.width,
            g.height,
            plane(&frame.r),
            plane(&frame.g),
            plane(&frame.b),
            ValidityMask::new_filled(g.width, g.height, true),
        )
    }

    /// On a canvas coarser than the mip, warping the mip lands where the
    /// full frame does and agrees with it on smooth content; on a fine
    /// canvas the mip is ignored and the warp stays bit-identical.
    #[test]
    fn coarse_canvases_warp_the_mip_in_place_of_the_frame() {
        let (w, h) = (400u32, 300u32);
        let smooth = |k: f32| -> Vec<f32> {
            (0..h)
                .flat_map(|y| {
                    (0..w).map(move |x| (x as f32 * 0.013 + y as f32 * 0.021 + k).sin() * 0.4 + 0.5)
                })
                .collect()
        };
        let frame = PlanarImage::from_planes(
            w,
            h,
            smooth(0.0),
            smooth(1.3),
            smooth(2.6),
            ValidityMask::new_filled(w, h, true),
        );
        let frames = [frame];
        let with_mip = WithMip {
            frames: InMemory(&frames),
            mip: box_mip(&frames[0]),
        };
        let cam = Camera::new([0.1, 0.4, -0.05], 1000.0, -0.05, 0.0, w, h);
        let gain = FramePhotometry {
            gain: [1.1, 0.95, 1.0],
            bias: [0.0; 3],
            falloff_q: 0.2,
        };
        let coarse = CanvasSpec::full_sphere(300).unwrap();
        assert!(cam.focal_px / coarse.pixels_per_radian() >= MIP_FACTOR as f64);
        let full = warp_stored_to_canvas(&InMemory(&frames), 0, &cam, &coarse, gain, None).unwrap();
        let mip = warp_stored_to_canvas(&with_mip, 0, &cam, &coarse, gain, None).unwrap();
        let inside = |x: u32, y: u32| {
            let (x, y) = (x as i64, y as i64);
            (-2..=2).all(|dy| {
                (-2..=2).all(|dx| {
                    let (nx, ny) = (x + dx, y + dy);
                    nx >= 0
                        && ny >= 0
                        && (nx as u32) < coarse.width
                        && (ny as u32) < coarse.height
                        && full.validity.get(nx as u32, ny as u32)
                })
            })
        };
        let (mut both, mut either, mut edge, mut interior) = (0usize, 0usize, 0.0f32, 0.0f32);
        for i in 0..full.r.len() {
            let (x, y) = ((i as u32) % coarse.width, (i as u32) / coarse.width);
            let (a, b) = (full.validity.get(x, y), mip.validity.get(x, y));
            either += usize::from(a || b);
            if a && b {
                both += 1;
                let d = [&full.r, &full.g, &full.b]
                    .iter()
                    .zip([&mip.r, &mip.g, &mip.b])
                    .map(|(f, m)| (f[i] - m[i]).abs())
                    .fold(0.0f32, f32::max);
                if inside(x, y) {
                    interior = interior.max(d);
                } else {
                    edge = edge.max(d);
                }
            }
        }
        assert!(both > 500, "footprint too small: {both}");
        assert!(
            both * 100 >= either * 95,
            "footprints differ: {both} of {either}"
        );
        assert!(
            interior < 0.012,
            "mip warp off by {interior} inside the footprint"
        );
        assert!(edge < 0.05, "mip warp off by {edge} at the footprint edge");

        let fine = CanvasSpec::full_sphere(1200).unwrap();
        let want = warp_stored_to_canvas(&InMemory(&frames), 0, &cam, &fine, gain, None).unwrap();
        let got = warp_stored_to_canvas(&with_mip, 0, &cam, &fine, gain, None).unwrap();
        assert_eq!((&got.g, &got.validity), (&want.g, &want.validity));
    }
}
