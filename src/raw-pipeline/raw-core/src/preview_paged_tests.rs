//! The paged extraction (#6033) against the whole-file one as its oracle.

use std::io;

use super::*;
use crate::paged_file::{EXTENT_ALIGN, MAX_EXTENTS};
use crate::test_support::paged::paged;
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::test_support::synth_dng_preview::dng_with_jpeg_preview;
use crate::test_support::synth_unknown_body::unknown_body_3fr;
use rawler::rawsource::LazyBytes;

type Extracted =
    std::result::Result<(u32, u32, image::ColorType, Vec<u8>, ExifOrientation), String>;

fn extracted(result: Result<(image::DynamicImage, ExifOrientation)>) -> Extracted {
    result
        .map(|(image, orientation)| {
            (
                image.width(),
                image.height(),
                image.color(),
                image.as_bytes().to_vec(),
                orientation,
            )
        })
        .map_err(|error| error.to_string())
}

struct Reads {
    calls: u32,
    bytes: u64,
}

fn paged_extraction(
    path: &std::path::Path,
    ext: &str,
) -> (Extracted, Reads, Option<io::ErrorKind>) {
    let file = paged(path);
    let result = extracted(extract_embedded_preview_from(
        RawSource::new_lazy(&file),
        ext,
    ));
    let reads = Reads {
        calls: file.read_calls(),
        bytes: file.bytes_read(),
    };
    (result, reads, file.failure().map(|e| e.kind()))
}

/// Extract `bytes` both ways, require identical results, and report the
/// paged reads.
fn agreed(bytes: &[u8], ext: &str) -> (Extracted, Reads) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(format!("source.{ext}"));
    std::fs::write(&path, bytes).unwrap();
    let whole = extracted(extract_embedded_preview(bytes, ext));
    let (paged, reads, failure) = paged_extraction(&path, ext);
    assert_eq!(failure, None);
    assert!(
        paged == whole,
        "paged and whole-file extraction differ for .{ext}"
    );
    assert!(reads.calls as usize <= MAX_EXTENTS + 1);
    (whole, reads)
}

fn noise_rgb(width: u32, height: u32) -> Vec<u8> {
    (0..width * height * 3)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8)
        .collect()
}

fn jpeg(width: u32, height: u32, quality: u8) -> Vec<u8> {
    crate::jpeg::encode(width, height, &noise_rgb(width, height), quality).unwrap()
}

fn padded(container: Vec<u8>, padding: usize) -> Vec<u8> {
    let filler = (0..padding).map(|i| (i.wrapping_mul(40_503) >> 7) as u8);
    container.into_iter().chain(filler).collect()
}

fn dng_with_preview(width: u32, height: u32, quality: u8) -> Vec<u8> {
    dng_with_jpeg_preview(&jpeg(width, height, quality), width, height)
}

#[test]
fn every_synthetic_container_extracts_the_same_paged() {
    let junk_then_jpeg = padded(b"not a tiff".to_vec(), 5000)
        .into_iter()
        .chain(jpeg(320, 288, 85))
        .collect::<Vec<u8>>();
    let cases: [(&str, Vec<u8>, bool); 6] = [
        ("dng", dng_with_preview(96, 64, 90), true),
        ("3fr", unknown_body_3fr(), true),
        ("dng", SyntheticGreyDng::default().write_to_bytes(), false),
        (
            "dng",
            b"not a real raw file, just some bytes".to_vec(),
            false,
        ),
        ("raw", junk_then_jpeg.clone(), true),
        ("x3f", junk_then_jpeg, true),
    ];
    for (ext, bytes, has_preview) in cases {
        let (result, _) = agreed(&bytes, ext);
        assert_eq!(result.is_ok(), has_preview, ".{ext}: {:?}", result.err());
    }
}

#[test]
fn a_raw_with_a_small_preview_costs_one_read_of_one_extent() {
    let bytes = padded(dng_with_preview(640, 480, 80), 8 * EXTENT_ALIGN);
    let (result, reads) = agreed(&bytes, "dng");
    assert!(result.is_ok());
    assert_eq!((reads.calls, reads.bytes), (1, EXTENT_ALIGN as u64));
}

#[test]
fn a_preview_longer_than_an_extent_costs_one_more_read() {
    let container = dng_with_preview(1280, 960, 97);
    assert!(container.len() > EXTENT_ALIGN, "{} bytes", container.len());
    let preview_extents = container.len().div_ceil(EXTENT_ALIGN);
    let bytes = padded(container, 16 * EXTENT_ALIGN);
    let (result, reads) = agreed(&bytes, "dng");
    assert!(result.is_ok());
    assert_eq!(reads.calls, 2);
    assert_eq!(reads.bytes, (preview_extents * EXTENT_ALIGN) as u64);
}

#[test]
fn a_container_that_must_be_scanned_is_read_whole() {
    let bytes = padded(b"no container".to_vec(), 3 * EXTENT_ALIGN)
        .into_iter()
        .chain(jpeg(320, 288, 85))
        .collect::<Vec<u8>>();
    let (result, reads) = agreed(&bytes, "x3f");
    assert!(result.is_ok());
    assert_eq!((reads.calls, reads.bytes), (1, bytes.len() as u64));
}

#[test]
fn truncated_files_fail_exactly_as_the_whole_file_read_does() {
    let with_preview = padded(dng_with_preview(1280, 960, 97), 4 * EXTENT_ALIGN);
    let unknown_body = unknown_body_3fr();
    for (ext, bytes) in [("dng", with_preview), ("3fr", unknown_body)] {
        let cuts = [
            1,
            3,
            4,
            7,
            8,
            60,
            300,
            4000,
            EXTENT_ALIGN - 1,
            EXTENT_ALIGN + 1,
        ]
        .into_iter()
        .chain([bytes.len() / 2, bytes.len() - 1])
        .filter(|&cut| cut < bytes.len());
        for cut in cuts {
            agreed(&bytes[..cut], ext);
        }
    }
}

#[test]
fn a_file_cut_short_during_extraction_is_a_read_error_not_a_panic() {
    let bytes = padded(dng_with_preview(1280, 960, 97), 16 * EXTENT_ALIGN);
    let dir = tempfile::tempdir().unwrap();
    for (ext, reads_before_failing) in [("dng", 2), ("x3f", 1)] {
        let path = dir.path().join(format!("source.{ext}"));
        std::fs::write(&path, &bytes).unwrap();
        let file = paged(&path);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(EXTENT_ALIGN as u64 + 9)
            .unwrap();
        let result = extract_embedded_preview_from(RawSource::new_lazy(&file), ext);
        match result {
            Err(Error::Io { source, .. }) => {
                assert_eq!(source.kind(), io::ErrorKind::UnexpectedEof)
            }
            other => panic!(".{ext}: expected a read error, got {:?}", other.err()),
        }
        assert_eq!(file.read_calls(), reads_before_failing, ".{ext}");
    }
}

fn is_raw_fixture(path: &std::path::Path) -> bool {
    const RAW_EXTENSIONS: [&str; 9] = [
        "dng", "cr2", "raf", "arw", "nef", "fff", "x3f", "raw", "3fr",
    ];
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| RAW_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Every RAW under `test-fixtures/raws/`, paged against whole. Run with
/// `--nocapture` for each fixture's read count and bytes.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn every_fixture_extracts_the_same_paged() {
    let root = crate::test_support::fixtures::require(crate::test_support::fixtures::raws_root());
    let fixtures = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| is_raw_fixture(path))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(!fixtures.is_empty());
    for path in fixtures {
        let ext = path
            .extension()
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        let bytes = std::fs::read(&path).unwrap();
        let whole = extracted(extract_embedded_preview(&bytes, &ext));
        let (paged, reads, failure) = paged_extraction(&path, &ext);
        let name = path.file_name().unwrap().to_string_lossy();
        assert_eq!(failure, None, "{name}");
        assert!(
            paged == whole,
            "{name}: paged and whole-file extraction differ"
        );
        assert!(reads.calls as usize <= MAX_EXTENTS + 1, "{name}");
        eprintln!(
            "{name}: {} bytes, {} reads, {} bytes read ({:.1}%), preview {}",
            bytes.len(),
            reads.calls,
            reads.bytes,
            100.0 * reads.bytes as f64 / bytes.len() as f64,
            whole.map_or_else(|e| e, |(w, h, ..)| format!("{w}x{h}"))
        );
    }
}
