use super::*;

#[test]
fn straighten_windows_match_full_crop_exactly_with_edges_and_empty_corners() {
    let (w, h) = (31, 19);
    let rgb: Vec<u8> = (0..w * h)
        .flat_map(|i| [(i % 251) as u8, (i / w * 11) as u8, (i % w * 7) as u8])
        .collect();
    for angle in [3.5, -12.0, 45.0, 89.7, 135.0, 270.2] {
        for crop in [
            Crop {
                angle,
                ..Crop::IDENTITY
            },
            Crop {
                left: 0.13,
                top: 0.17,
                right: 0.87,
                bottom: 0.91,
                angle,
            },
        ] {
            let (dw, dh, expected) = super::super::apply_u8_rgb(&rgb, w, h, &crop);
            for (x, y) in [(0, 0), (dw - 7, dh - 5), (dw / 3, dh / 3)] {
                let mapping = CropDetailWindow::new(&crop, w, h, (x, y, 7, 5)).unwrap();
                let (sx, sy, sw, sh) = mapping.source();
                let source: Vec<u8> = (sy..sy + sh)
                    .flat_map(|row| {
                        let i = (row * w + sx) as usize * 3;
                        rgb[i..i + sw as usize * 3].iter().copied()
                    })
                    .collect();
                let (pw, ph, actual) = mapping.apply_rgb(source, CancelToken::never()).unwrap();
                let wanted: Vec<u8> = (y..y + 5)
                    .flat_map(|row| {
                        let i = (row * dw + x) as usize * 3;
                        expected[i..i + 7 * 3].iter().copied()
                    })
                    .collect();
                assert_eq!((pw, ph), (7, 5));
                assert_eq!(actual, wanted, "angle={angle}, origin={x},{y}");
            }
        }
    }
}

#[test]
fn large_coordinate_source_bounds_include_all_bilinear_neighbours() {
    for (width, height) in [(11648, 8736), (16_777_217, 19), (268_000_000, 3)] {
        for angle in [-12.0, 3.5, 89.7, 135.0] {
            let crop = Crop {
                angle,
                ..Crop::IDENTITY
            };
            let x = width / 3;
            let y = height / 3;
            let w = 128.min(width - x);
            let h = 64.min(height - y);
            let mapping = CropDetailWindow::new(&crop, width, height, (x, y, w, h)).unwrap();
            let CropDetailWindow::Straighten(window) = mapping else {
                panic!("straighten");
            };
            let (sx, sy, sw, sh) = window.source;
            for row in 0..h {
                for col in 0..w {
                    let (px, py) = window.rotation.source_pixel(
                        window.crop_origin.0,
                        window.crop_origin.1,
                        x + col,
                        y + row,
                    );
                    let (ix, iy) = (px.floor() as i32, py.floor() as i32);
                    if ix + 1 < 0 || iy + 1 < 0 || ix >= width as i32 || iy >= height as i32 {
                        continue;
                    }
                    for xx in [ix, ix + 1] {
                        for yy in [iy, iy + 1] {
                            let xx = xx.clamp(0, width as i32 - 1) as u32;
                            let yy = yy.clamp(0, height as i32 - 1) as u32;
                            assert!(xx >= sx && xx < sx + sw && yy >= sy && yy < sy + sh);
                        }
                    }
                }
            }
        }
    }
}
