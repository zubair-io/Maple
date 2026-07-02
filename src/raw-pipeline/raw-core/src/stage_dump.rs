//! Feature-gated per-stage OpenEXR buffer dumps. Active when the binary is
//! built with `--features stage-dump` AND the `MAPLE_STAGE_DUMP` env var
//! is set to a directory path. Used by `src/scripts/stage_diff.py` to
//! localize divergence to a specific pipeline stage.

#![cfg(feature = "stage-dump")]

use std::path::Path;

use crate::image::Image;
use exr::prelude::*;

/// Read MAPLE_STAGE_DUMP once. Returns Some(path) when set to a non-empty
/// value AND the directory exists (or can be created). Returns None
/// otherwise — pipeline.rs callers no-op when None.
pub fn dump_dir() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("MAPLE_STAGE_DUMP")?;
    let s = raw.to_string_lossy();
    if s.is_empty() {
        return None;
    }
    let p = std::path::PathBuf::from(s.as_ref());
    std::fs::create_dir_all(&p).ok()?;
    Some(p)
}

/// Write `image` to `<dir>/<name>.exr` as 32-bit RGB OpenEXR. Errors are
/// logged to stderr and swallowed — diagnostic dumping must never break a
/// render.
pub fn dump_image(name: &str, image: &Image, dir: &Path) {
    let path = dir.join(format!("{name}.exr"));
    let width = image.width as usize;
    let height = image.height as usize;
    if image.pixels.len() != width * height {
        eprintln!(
            "[stage-dump] {name}: pixel count {} != {}*{} = {}; skipping",
            image.pixels.len(),
            width,
            height,
            width * height
        );
        return;
    }
    let result = write_rgb_file(&path, width, height, |x, y| {
        let p = image.pixels[y * width + x];
        (p[0], p[1], p[2])
    });
    if let Err(e) = result {
        eprintln!("[stage-dump] {name}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    #[test]
    fn dump_image_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        img.pixels = vec![
            [1.0, 0.5, 0.25],
            [0.0, 1.0, 0.5],
            [0.5, 0.25, 1.0],
            [0.75, 0.5, 0.25],
        ];
        dump_image("test", &img, dir.path());

        let path = dir.path().join("test.exr");
        assert!(path.exists(), "exr file should be written");

        // Read back via exr's rgba reader. The create closure receives
        // (Vec2<usize> resolution, &RgbaChannels) and returns the pixel buffer;
        // the set_pixel closure receives (&mut buffer, Vec2<usize> pos, (r,g,b,a)).
        // We store only (r, g, b) since we wrote RGB.
        let image = read_first_rgba_layer_from_file(
            path,
            |resolution, _channels| {
                vec![(0.0_f32, 0.0_f32, 0.0_f32); resolution.x() * resolution.y()]
            },
            |buffer, pos, (r, g, b, _a): (f32, f32, f32, f32)| {
                buffer[pos.y() * 2 + pos.x()] = (r, g, b);
            },
        )
        .unwrap();

        let pixels = image.layer_data.channel_data.pixels;
        assert_eq!(pixels.len(), 4);
        assert!((pixels[0].0 - 1.0).abs() < 1e-4, "pixel[0].r mismatch");
        assert!((pixels[0].1 - 0.5).abs() < 1e-4, "pixel[0].g mismatch");
        assert!((pixels[0].2 - 0.25).abs() < 1e-4, "pixel[0].b mismatch");
        assert!((pixels[3].2 - 0.25).abs() < 1e-4, "pixel[3].b mismatch");
    }
}
