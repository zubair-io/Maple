use super::*;
use raw_core::test_support::synth_unknown_body::{
    preview_rgb, unknown_body_3fr, PREVIEW_HEIGHT, PREVIEW_WIDTH,
};
use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::SystemTime,
};

fn raw_at(path: &Path, bytes: &[u8]) -> Photo {
    std::fs::write(path, bytes).unwrap();
    Photo {
        path: path.to_owned(),
        kind: crate::library::MediaKind::Raw,
        modified: SystemTime::now(),
        size: bytes.len() as u64,
    }
}

struct Counting<R> {
    inner: R,
    bytes_read: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.bytes_read.fetch_add(read as u64, Ordering::SeqCst);
        Ok(read)
    }
}

impl<R: Seek> Seek for Counting<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.inner.seek(position)
    }
}

const PADDING: usize = 16 << 20;

fn large_raw(folder: &Path) -> Photo {
    let padded = [unknown_body_3fr(), vec![0x5a; PADDING]].concat();
    raw_at(&folder.join("IMG_0001.3fr"), &padded)
}

#[test]
fn the_preview_inside_a_real_file_is_cut_to_the_thumbnail_size_by_the_shared_extractor() {
    let folder = tempfile::tempdir().unwrap();
    let jpeg = raw_core::jpeg::encode(800, 400, &vec![120; 800 * 400 * 3], 90).unwrap();
    let container = [b"FOVb".as_slice(), &[0; 64], &jpeg, &[0; 64]].concat();
    let photo = raw_at(&folder.path().join("IMG_0001.x3f"), &container);

    let preview = camera_preview(&photo, 512).expect("the file holds a camera preview");

    assert_eq!(preview.dimensions(), (512, 256));
}

#[test]
fn a_preview_at_the_start_of_a_large_raw_is_found_without_reading_the_rest_of_the_file() {
    let folder = tempfile::tempdir().unwrap();
    let photo = large_raw(folder.path());
    let bytes_read = Arc::new(AtomicU64::new(0));
    let reader = Counting {
        inner: File::open(&photo.path).unwrap(),
        bytes_read: bytes_read.clone(),
    };

    let preview = preview_from(reader, "3fr", 512).expect("the file holds a camera preview");

    assert_eq!(preview.width().max(preview.height()), PREVIEW_WIDTH);
    let read = bytes_read.load(Ordering::SeqCst);
    assert!(
        read > 0 && read <= 2 << 20,
        "{read} of {} bytes were read",
        photo.size
    );
}

#[test]
fn a_format_decoded_from_every_byte_is_read_whole() {
    let folder = tempfile::tempdir().unwrap();
    let photo = large_raw(folder.path());
    let bytes_read = Arc::new(AtomicU64::new(0));
    let reader = Counting {
        inner: File::open(&photo.path).unwrap(),
        bytes_read: bytes_read.clone(),
    };

    preview_from(reader, "tif", 512);

    assert_eq!(bytes_read.load(Ordering::SeqCst), photo.size);
}

#[test]
fn a_rotated_preview_is_turned_upright_exactly_once() {
    let folder = tempfile::tempdir().unwrap();
    let photo = raw_at(&folder.path().join("IMG_0001.3fr"), &unknown_body_3fr());

    let preview = camera_preview(&photo, 512).expect("the file holds a camera preview");

    let (width, height, upright) = raw_core::image::apply_orientation(
        &preview_rgb(),
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
        raw_core::image::ExifOrientation::Rotate90,
    );
    assert_eq!((width, height), (PREVIEW_HEIGHT, PREVIEW_WIDTH));
    assert_eq!(preview.dimensions(), (width, height));
    assert_eq!(preview.as_raw(), &upright);
}

#[test]
fn a_file_with_no_preview_or_no_bytes_gives_none() {
    let folder = tempfile::tempdir().unwrap();
    let photo = raw_at(&folder.path().join("IMG_0001.dng"), b"not a raw file");
    assert!(camera_preview(&photo, 512).is_none());

    let missing = Photo {
        path: folder.path().join("missing.dng"),
        ..photo
    };
    assert!(camera_preview(&missing, 512).is_none());
}
