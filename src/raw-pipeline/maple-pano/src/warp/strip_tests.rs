use super::*;

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

fn rows_of(src: &PlanarImage, y0: u32, rows: u32) -> PlanarImage {
    let w = src.width() as usize;
    let range = y0 as usize * w..(y0 + rows) as usize * w;
    let mut validity = ValidityMask::new_filled(src.width(), rows, true);
    for y in 0..rows {
        for x in 0..src.width() {
            validity.set(x, y, src.validity.get(x, y0 + y));
        }
    }
    PlanarImage::from_planes(
        src.width(),
        rows,
        src.r[range.clone()].to_vec(),
        src.g[range.clone()].to_vec(),
        src.b[range].to_vec(),
        validity,
    )
}

/// Windowed strips are bit-identical to full-frame strips, read strictly
/// fewer rows than the frame for strips the frame only partly covers, and
/// never read for strips it misses.
#[test]
fn windowed_strips_match_full_frame_strips() {
    let src = textured(96, 72);
    let gain = FramePhotometry {
        gain: [1.1, 0.9, 1.05],
        bias: [0.002, -0.001, 0.0],
        falloff_q: 0.3,
    };
    let canvas = CanvasSpec::full_sphere(160).unwrap();
    for rotation in [[0.2, -0.1, 0.05], [0.0, 1.2, -0.4], [2.9, 0.3, 0.7]] {
        let cam = Camera::new(rotation, 120.0, -0.08, 0.01, 96, 72);
        let mut narrower = 0;
        for tile_rows in [1u32, 7, canvas.height / 3, canvas.height] {
            for tile_y0 in (0..canvas.height).step_by(tile_rows as usize) {
                let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
                let want = warp_to_canvas_strip(&src, &cam, &canvas, gain, None, tile_y0, tile_y1);
                let mut read = None;
                let got = warp_window_to_canvas_strip::<()>(
                    &cam,
                    &canvas,
                    gain,
                    None,
                    tile_y0,
                    tile_y1,
                    |y0, rows| {
                        read = Some((y0, rows));
                        Ok(rows_of(&src, y0, rows))
                    },
                )
                .unwrap();
                assert_eq!(
                    (got.r, got.g, got.b),
                    (want.r, want.g, want.b),
                    "{rotation:?} [{tile_y0},{tile_y1})"
                );
                assert_eq!(got.validity, want.validity);
                match read {
                    Some((_, rows)) if rows < src.height() => narrower += 1,
                    None => assert!(!want.validity.any_valid(), "a covered strip must read"),
                    _ => {}
                }
            }
        }
        assert!(narrower > 0, "{rotation:?}: no strip read a partial window");
    }
}
