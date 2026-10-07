//! Source dimensions must survive bounded previews and external replacements.
use super::*;

#[test]
fn raster_native_dimensions_follow_opened_snapshot_and_exif_orientation() {
    // RGB TIFF fixture with a real top-level Orientation tag.
    let mut tiff = raw_core::tiff::encode_from_u8(80, 60, &[90; 80 * 60 * 3]).unwrap();
    assert_eq!(&tiff[..2], b"II");
    let old = u32::from_le_bytes(tiff[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(tiff[old..old + 2].try_into().unwrap());
    let entries = tiff[old + 2..old + 2 + usize::from(count) * 12].to_vec();
    let next = tiff[old + 2 + usize::from(count) * 12..old + 6 + usize::from(count) * 12].to_vec();
    let offset = tiff.len() as u32;
    tiff[4..8].copy_from_slice(&offset.to_le_bytes());
    tiff.extend_from_slice(&(count + 1).to_le_bytes());
    tiff.extend_from_slice(&entries);
    tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]);
    tiff.extend_from_slice(&next);
    assert_eq!(raw_core::raster::container_orientation(&tiff), Some(6));
    for (extension, bytes) in [
        (
            "png",
            raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap(),
        ),
        ("tiff", tiff),
        (
            "tiff",
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../test-fixtures/jpeg-tiff/orientation6.tiff"),
            )
            .unwrap(),
        ),
        (
            "tiff",
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../test-fixtures/jpeg-tiff/bigtiff.tiff"),
            )
            .unwrap(),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(format!("photo.{extension}"));
        std::fs::write(&path, &bytes).unwrap();
        let photo = Folder::scan(root.path()).unwrap().photos.remove(0);
        let (session, document) = Session::open(1, photo).unwrap();
        let full = session.render(&document.model, u32::MAX).unwrap();
        assert_eq!(
            session.native_size,
            (full.size[0] as u32, full.size[1] as u32)
        );
        let bounded = session.render(&document.model, 8).unwrap();
        assert!(bounded.size[0].max(bounded.size[1]) <= 8);
        assert_ne!(full.size, bounded.size);
        // Dimensions belong to the open snapshot, just like its pixels.
        std::fs::write(&path, b"externally replaced").unwrap();
        assert_eq!(
            session.render(&document.model, u32::MAX).unwrap().pixels,
            full.pixels
        );
        assert_eq!(
            session.native_size,
            (full.size[0] as u32, full.size[1] as u32)
        );
    }
}
