use super::*;
use crate::types::accepted_removal::NativeWindow;

#[test]
fn normalized_native_windows_preserve_binary_coverage_exactly() {
    for (source_w, source_h) in [(5984, 3992), (12288, 8192), (8256, 6192)] {
        let patch_window = NativeWindow {
            x: 400,
            y: 1000,
            width: 1024,
            height: 1024,
        };
        let region = patch_window.region(source_w, source_h);
        let patch = InpaintPatch {
            width: 1024,
            height: 1024,
            origin: [region[0], region[1]],
            extent: [region[2], region[3]],
            pixels: vec![[-0.125, 0.18, 8.0]; 1024 * 1024],
            coverage: (0..1024 * 1024)
                .map(|i| {
                    if (412..612).contains(&(i % 1024)) && (412..612).contains(&(i / 1024)) {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect(),
        };
        for (x, y, width, height) in [(0, 0, 1024, 1024), (400, 400, 32, 32), (600, 600, 24, 24)] {
            let window = NativeWindow {
                x: 400 + x,
                y: 1000 + y,
                width,
                height,
            };
            let mut image = Image::new(width, height, ColorSpace::SceneLinearRec2020);
            image.pixels.fill([65504.0, -65504.0, -0.0]);
            apply_window(
                &mut image,
                &[patch.clone()],
                window.region(source_w, source_h),
            )
            .unwrap();
            for iy in 0..height {
                for ix in 0..width {
                    let index = ((iy + y) * 1024 + ix + x) as usize;
                    let expected = if patch.coverage[index] == 0.0 {
                        [65504.0, -65504.0, -0.0]
                    } else {
                        patch.pixels[index]
                    };
                    let actual = image.pixels[(iy * width + ix) as usize];
                    for c in 0..3 {
                        assert_eq!(actual[c].to_bits(), expected[c].to_bits());
                    }
                }
            }
        }
    }
}
