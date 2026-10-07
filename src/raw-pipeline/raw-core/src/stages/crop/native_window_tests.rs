use super::*;

#[test]
fn integer_windows_match_shared_crop_at_boundaries_and_interior() {
    let (w, h) = (31, 19);
    let rgb: Vec<u8> = (0..w * h)
        .flat_map(|i| [(i % 251) as u8, (i / w * 11) as u8, (i % w * 7) as u8])
        .collect();
    for angle in [0.0, 0.009, 90.0, 180.0, 270.0, -90.0, 360.0] {
        let crop = Crop {
            left: 0.13,
            top: 0.17,
            right: 0.87,
            bottom: 0.91,
            angle,
        };
        let (dw, dh, expected) = super::super::apply_u8_rgb(&rgb, w, h, &crop);
        for (x, y) in [(0, 0), (dw - 7, dh - 5)] {
            let mapped = NativeCropWindow::new(&crop, w, h, (x, y, 7, 5)).unwrap();
            let (sx, sy, sw, sh) = mapped.source;
            let source: Vec<u8> = (sy..sy + sh)
                .flat_map(|row| {
                    let start = (row * w + sx) as usize * 3;
                    rgb[start..start + sw as usize * 3].iter().copied()
                })
                .collect();
            let (pw, ph, patch) =
                crate::image::apply_orientation(&source, sw, sh, mapped.orientation);
            let wanted: Vec<u8> = (y..y + 5)
                .flat_map(|row| {
                    let start = (row * dw + x) as usize * 3;
                    expected[start..start + 7 * 3].iter().copied()
                })
                .collect();
            assert_eq!((pw, ph), (7, 5));
            assert_eq!(patch, wanted, "angle={angle} origin={x},{y}");
        }
        assert!(NativeCropWindow::new(&crop, w, h, (dw, 0, 1, 1)).is_none());
        assert!(NativeCropWindow::new(&crop, w, h, (u32::MAX, 0, 1, 1)).is_none());
    }
    assert!(!NativeCropWindow::supported(&Crop {
        angle: 3.5,
        ..Crop::IDENTITY
    }));
}
