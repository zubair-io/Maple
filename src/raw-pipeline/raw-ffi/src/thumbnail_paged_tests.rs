//! The thumbnail externs' paged read (#6033) against the whole-file read as its oracle.

use crate::error::maple_last_error;
use crate::thumbnail::{
    maple_render_thumbnail_avif_to_file, maple_render_thumbnail_preview_jpeg_buf,
    maple_render_thumbnail_preview_jpeg_to_file, upright_pixels,
};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::test_support::synth_dng_preview::dng_with_jpeg_preview;
use raw_core::test_support::synth_unknown_body::unknown_body_3fr;
use std::ffi::{CStr, CString};
use std::path::Path;

const MIB: usize = 1 << 20;

type Pixels = Result<(u32, u32, Vec<u8>), (i32, String)>;

fn pixels(path: &Path, max_px: u32, whole_file: bool) -> Pixels {
    upright_pixels(path, max_px, whole_file).map_err(|rc| (rc, last_error()))
}

fn last_error() -> String {
    unsafe { CStr::from_ptr(maple_last_error()) }
        .to_str()
        .unwrap()
        .to_owned()
}

fn c_path(path: &Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

fn written(rc: i32, out: &Path) -> Result<Vec<u8>, (i32, String)> {
    match rc {
        0 => Ok(std::fs::read(out).unwrap()),
        rc => Err((rc, last_error())),
    }
}

fn avif_extern(
    raw: &Path,
    out_dir: &Path,
    max_px: u32,
    quality: u8,
) -> Result<Vec<u8>, (i32, String)> {
    let out = out_dir.join("out.avif");
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(
            c_path(raw).as_ptr(),
            c_path(&out).as_ptr(),
            max_px,
            quality,
        )
    };
    written(rc, &out)
}

fn jpeg_extern(
    raw: &Path,
    out_dir: &Path,
    max_px: u32,
    quality: u8,
) -> Result<Vec<u8>, (i32, String)> {
    let out = out_dir.join("out.jpg");
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(
            c_path(raw).as_ptr(),
            c_path(&out).as_ptr(),
            max_px,
            quality,
        )
    };
    written(rc, &out)
}

fn jpeg_buf_extern(raw: &Path, max_px: u32, quality: u8) -> Result<Vec<u8>, (i32, String)> {
    let mut buf = vec![0u8; 64 * MIB];
    let mut len = 0usize;
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            c_path(raw).as_ptr(),
            max_px,
            quality,
            buf.as_mut_ptr(),
            buf.len(),
            &mut len,
        )
    };
    match rc {
        0 => Ok(buf[..len].to_vec()),
        rc => Err((rc, last_error())),
    }
}

/// Every entry point against the whole-file oracle, at `max_px`.
fn assert_matches_whole_file_read(raw: &Path, max_px: u32) -> Pixels {
    let name = raw.file_name().unwrap().to_string_lossy().into_owned();
    let oracle = pixels(raw, max_px, true);
    assert!(
        pixels(raw, max_px, false) == oracle,
        "{name}: pixels differ"
    );
    let out_dir = tempfile::tempdir().unwrap();
    let encoded = |encode: fn(u32, u32, &[u8], u8) -> raw_core::Result<Vec<u8>>, quality: u8| {
        oracle
            .clone()
            .map(|(width, height, rgb)| encode(width, height, &rgb, quality).unwrap())
    };
    assert!(
        avif_extern(raw, out_dir.path(), max_px, 55) == encoded(raw_core::avif::encode, 55),
        "{name}: AVIF differs"
    );
    let jpeg = encoded(raw_core::jpeg::encode, 85);
    assert!(
        jpeg_extern(raw, out_dir.path(), max_px, 0) == jpeg,
        "{name}: JPEG differs"
    );
    assert!(
        jpeg_buf_extern(raw, max_px, 0) == jpeg,
        "{name}: JPEG buffer differs"
    );
    oracle
}

fn photo_jpeg(width: u32, height: u32, quality: u8) -> Vec<u8> {
    let photo = image::RgbImage::from_fn(width, height, |x, y| {
        let noise = (x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)) >> 24;
        image::Rgb([(x % 256) as u8, (y % 256) as u8, noise as u8])
    });
    raw_core::jpeg::encode(width, height, photo.as_raw(), quality).unwrap()
}

fn padded(container: Vec<u8>, padding: usize) -> Vec<u8> {
    let filler = (0..padding).map(|i| (i.wrapping_mul(40_503) >> 7) as u8);
    container.into_iter().chain(filler).collect()
}

fn raw_with_preview() -> Vec<u8> {
    padded(
        dng_with_jpeg_preview(&photo_jpeg(1280, 960, 97), 1280, 960),
        6 * MIB,
    )
}

fn staged(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn synthetic_sources_render_as_the_whole_file_read_does() {
    let dir = tempfile::tempdir().unwrap();
    let camera_jpeg = photo_jpeg(640, 480, 90);
    let cases: [(&str, Vec<u8>, Option<i32>); 8] = [
        ("preview.dng", raw_with_preview(), None),
        ("unknown-body.3fr", unknown_body_3fr(), None),
        (
            "no-preview.dng",
            SyntheticGreyDng::default().write_to_bytes(),
            Some(8),
        ),
        ("garbage.dng", b"not a real raw file".to_vec(), Some(8)),
        ("empty.dng", Vec::new(), Some(8)),
        ("photo.jpg", camera_jpeg.clone(), None),
        (
            "jpeg-named-raw.dng",
            padded(camera_jpeg.clone(), 3 * MIB),
            None,
        ),
        ("scanned.x3f", padded(camera_jpeg, 3 * MIB), None),
    ];
    for (name, bytes, failure) in cases {
        let raw = staged(dir.path(), name, &bytes);
        let outcome = assert_matches_whole_file_read(&raw, 96);
        assert_eq!(outcome.err().map(|(rc, _)| rc), failure, "{name}");
    }
}

#[test]
fn truncated_raws_fail_as_the_whole_file_read_does() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = raw_with_preview();
    for cut in [
        2,
        4,
        9,
        200,
        5000,
        MIB - 1,
        MIB + 1,
        bytes.len() / 2,
        bytes.len() - 1,
    ] {
        let raw = staged(dir.path(), "cut.dng", &bytes[..cut]);
        let oracle = pixels(&raw, 256, true);
        assert!(pixels(&raw, 256, false) == oracle, "cut at {cut}");
    }
}

#[test]
fn a_directory_is_a_read_error_either_way() {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("folder.dng");
    std::fs::create_dir(&raw).unwrap();
    let oracle = pixels(&raw, 256, true);
    assert_eq!(oracle.as_ref().err().map(|(rc, _)| *rc), Some(6));
    assert_eq!(pixels(&raw, 256, false), oracle);
}

fn is_raw_fixture(path: &Path) -> bool {
    const RAW_EXTENSIONS: [&str; 9] = [
        "dng", "cr2", "raf", "arw", "nef", "fff", "x3f", "raw", "3fr",
    ];
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| RAW_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn every_fixture_renders_as_the_whole_file_read_does() {
    use raw_core::test_support::fixtures::{raws_root, require};
    let fixtures = std::fs::read_dir(require(raws_root()))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| is_raw_fixture(path))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(!fixtures.is_empty());
    for raw in fixtures {
        for max_px in [512, 1280] {
            assert_matches_whole_file_read(&raw, max_px);
        }
    }
}
