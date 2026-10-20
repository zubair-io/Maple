//! Feature-gated per-stage OpenEXR buffer dumps. Active when the binary is
//! built with `--features stage-dump` AND the `MAPLE_STAGE_DUMP` env var
//! is set to a directory path. Used by `src/scripts/stage_diff.py` to
//! localize divergence to a specific pipeline stage. Optional
//! `MAPLE_STAGE_DUMP_ROI=x,y,width,height` limits each dump to a region
//! and writes a JSON sidecar with its full-buffer origin and color space.

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

/// Optional crop in full-buffer coordinates. Parsing is pure so tests never
/// change process-global environment variables while other tests are running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DumpRegion {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

impl DumpRegion {
    fn parse(spec: &str, width: usize, height: usize) -> std::result::Result<Self, String> {
        let fields = spec
            .split(',')
            .map(|v| v.trim().parse::<usize>())
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "ROI requires four unsigned integers")?;
        if fields.len() != 4 || fields[2] == 0 || fields[3] == 0 {
            return Err("ROI requires x,y,width,height with nonzero dimensions".into());
        }
        let (x, y) = (fields[0], fields[1]);
        if x >= width || y >= height {
            return Err("ROI is outside the stage buffer".into());
        }
        Ok(Self {
            x,
            y,
            width: fields[2].min(width - x),
            height: fields[3].min(height - y),
        })
    }
}

/// Write `image` to `<dir>/<name>.exr` as 32-bit RGB OpenEXR. Errors are
/// logged to stderr and swallowed — diagnostic dumping must never break a
/// render.
pub fn dump_image(name: &str, image: &Image, dir: &Path) {
    let region = match std::env::var("MAPLE_STAGE_DUMP_ROI") {
        Ok(spec) => match DumpRegion::parse(&spec, image.width as usize, image.height as usize) {
            Ok(region) => Some(region),
            Err(error) => {
                eprintln!("[stage-dump] {name}: {error}; skipping dump");
                return;
            }
        },
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => {
            eprintln!("[stage-dump] {name}: invalid ROI: {error}; skipping dump");
            return;
        }
    };
    dump_image_region(name, image, dir, region);
}

fn dump_image_region(name: &str, image: &Image, dir: &Path, region: Option<DumpRegion>) {
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
    let selected = region.unwrap_or(DumpRegion {
        x: 0,
        y: 0,
        width,
        height,
    });
    let result = write_rgb_file(&path, selected.width, selected.height, |x, y| {
        let p = image.pixels[(selected.y + y) * width + selected.x + x];
        (p[0], p[1], p[2])
    });
    if let Err(e) = result {
        eprintln!("[stage-dump] {name}: {e}");
        return;
    }
    if region.is_some() {
        let metadata = serde_json::json!({
            "origin": [selected.x, selected.y],
            "dimensions": [selected.width, selected.height],
            "full_dimensions": [width, height],
            "space": format!("{:?}", image.space),
        });
        if let Err(error) = std::fs::write(dir.join(format!("{name}.json")), metadata.to_string()) {
            eprintln!("[stage-dump] {name}: ROI metadata: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    #[test]
    fn region_clips_to_buffer_without_overflow() {
        assert_eq!(
            DumpRegion::parse("2, 1, 999999, 999999", 4, 3).unwrap(),
            DumpRegion {
                x: 2,
                y: 1,
                width: 2,
                height: 2
            }
        );
    }

    #[test]
    fn region_rejects_invalid_or_empty_coordinates() {
        for spec in [
            "0,0,0,1",
            "0,0,1,0",
            "-1,0,1,1",
            "0,0,1",
            "0,0,1,1,2",
            "4,0,1,1",
            "0,3,1,1",
        ] {
            assert!(DumpRegion::parse(spec, 4, 3).is_err(), "{spec}");
        }
    }

    #[test]
    fn cropped_dump_retains_values_and_full_buffer_origin() {
        let dir = tempfile::tempdir().unwrap();
        let mut img = Image::new(4, 3, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [i as f32, -2.0, 3.5];
        }
        dump_image_region(
            "crop",
            &img,
            dir.path(),
            Some(DumpRegion {
                x: 1,
                y: 1,
                width: 2,
                height: 1,
            }),
        );
        let image = read_first_rgba_layer_from_file(
            dir.path().join("crop.exr"),
            |resolution, _| vec![[0.0f32; 3]; resolution.x() * resolution.y()],
            |buffer, pos, (r, g, b, _): (f32, f32, f32, f32)| {
                buffer[pos.y() * 2 + pos.x()] = [r, g, b];
            },
        )
        .unwrap();
        assert_eq!(image.layer_data.size, Vec2(2, 1));
        assert_eq!(
            image.layer_data.channel_data.pixels,
            vec![[5.0, -2.0, 3.5], [6.0, -2.0, 3.5]]
        );
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("crop.json")).unwrap()).unwrap();
        assert_eq!(metadata["origin"], serde_json::json!([1, 1]));
        assert_eq!(metadata["full_dimensions"], serde_json::json!([4, 3]));
    }

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
