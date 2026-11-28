use super::*;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, SystemTime},
};

fn photo_in(folder: &Path, name: &str) -> Photo {
    let path = folder.join(name);
    fs::write(&path, b"not decoded: the develop is a stand-in").unwrap();
    Photo {
        path,
        kind: crate::library::MediaKind::Raw,
        modified: SystemTime::now(),
        size: 1,
    }
}

fn tile(width: u32, height: u32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    })
}

struct Renders {
    developed: AtomicUsize,
    extracted: AtomicUsize,
    camera_has_a_preview: bool,
}

impl Renders {
    fn new() -> Self {
        Self {
            developed: AtomicUsize::new(0),
            extracted: AtomicUsize::new(0),
            camera_has_a_preview: false,
        }
    }

    fn with_camera_preview() -> Self {
        Self {
            camera_has_a_preview: true,
            ..Self::new()
        }
    }

    fn develop(&self, _: &Photo, long_edge: u32) -> Result<RgbImage, String> {
        self.developed.fetch_add(1, Ordering::SeqCst);
        Ok(tile(long_edge, long_edge * 2 / 3))
    }

    fn camera_preview(&self, _: &Photo, long_edge: u32) -> Option<RgbImage> {
        self.extracted.fetch_add(1, Ordering::SeqCst);
        self.camera_has_a_preview
            .then(|| tile(long_edge, long_edge * 2 / 3))
    }

    fn count(&self) -> usize {
        self.developed.load(Ordering::SeqCst)
    }

    fn extractions(&self) -> usize {
        self.extracted.load(Ordering::SeqCst)
    }
}

fn produce_with(renders: &Renders, photo: &Photo) -> Result<(RgbImage, Source), String> {
    produce(
        photo,
        &|photo, edge| renders.develop(photo, edge),
        &|photo, edge| renders.camera_preview(photo, edge),
        &disk::encode,
    )
}

fn an_hour_from_now() -> SystemTime {
    SystemTime::now() + Duration::from_secs(3600)
}

fn touch(path: &Path, when: SystemTime) {
    fs::File::options()
        .append(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
fn a_second_visit_renders_nothing_and_reads_the_published_thumbnail() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();

    let (first, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 1));

    let (second, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Cache, 1));
    assert_eq!(second.dimensions(), first.dimensions());
}

#[test]
fn the_thumbnail_is_published_atomically_under_the_shared_name() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    produce_with(&Renders::new(), &photo).unwrap();

    let published: Vec<_> = fs::read_dir(folder.path().join(".maple/thumbs"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(published, ["IMG_0001.CR2.avif"]);
    let bytes = fs::read(folder.path().join(".maple/thumbs/IMG_0001.CR2.avif")).unwrap();
    let decoded = raw_core::raster::decode_raster(&bytes, Some("avif")).unwrap();
    assert_eq!(decoded.width.max(decoded.height), disk::LONG_EDGE_PX);
}

#[test]
fn a_changed_original_is_rendered_again() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();
    produce_with(&renders, &photo).unwrap();

    touch(&photo.path, an_hour_from_now());

    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
}

#[test]
fn a_newer_sidecar_renders_the_thumbnail_again() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();
    produce_with(&renders, &photo).unwrap();

    write_sidecar(&photo, |_| {});
    touch(&folder.path().join("IMG_0001.xmp"), an_hour_from_now());

    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
}

#[test]
fn a_corrupt_entry_is_rendered_again_and_replaced() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();
    produce_with(&renders, &photo).unwrap();
    let entry = folder.path().join(".maple/thumbs/IMG_0001.CR2.avif");
    fs::write(&entry, b"not an avif").unwrap();
    touch(&entry, an_hour_from_now());

    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
    touch(&entry, an_hour_from_now());
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Cache, 2));
}

#[test]
fn an_unwritable_cache_folder_still_shows_the_thumbnail() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    fs::write(
        folder.path().join(".maple"),
        b"a file where the folder belongs",
    )
    .unwrap();
    let renders = Renders::new();

    let (image, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!(source, Source::Developed);
    assert_eq!(image.width(), disk::LONG_EDGE_PX);
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
}

#[test]
fn a_symlinked_cache_folder_is_never_written_through() {
    let folder = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    std::os::unix::fs::symlink(elsewhere.path(), folder.path().join(".maple")).unwrap();

    let (_, source) = produce_with(&Renders::new(), &photo).unwrap();

    assert_eq!(source, Source::Developed);
    assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
}

#[test]
fn a_failed_develop_is_an_error_and_publishes_nothing() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");

    let failed = produce(
        &photo,
        &|_, _| Err("cannot decode".into()),
        &|_, _| None,
        &disk::encode,
    );

    assert_eq!(failed.unwrap_err(), "cannot decode");
    assert!(!folder.path().join(".maple").exists());
}

#[test]
fn the_grid_shows_a_tile_no_larger_than_its_display_size() {
    let shown = display(tile(512, 341));
    assert_eq!(shown.size, [256, 171]);
    let small = display(tile(100, 60));
    assert_eq!(small.size, [100, 60]);
}

fn write_sidecar(photo: &Photo, edit: impl FnOnce(&mut crate::sidecar::SidecarDocument)) {
    let mut document = crate::sidecar::SidecarDocument::default();
    edit(&mut document);
    fs::write(
        crate::sidecar::sidecar_path(&photo.path).unwrap(),
        document.serialize().unwrap(),
    )
    .unwrap();
}

#[test]
fn an_unedited_photo_with_a_camera_preview_uses_it_and_publishes_it() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::with_camera_preview();

    let (image, source) = produce_with(&renders, &photo).unwrap();

    assert_eq!(source, Source::CameraPreview);
    assert_eq!((renders.count(), renders.extractions()), (0, 1));
    assert_eq!(image.width(), disk::LONG_EDGE_PX);
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.extractions()), (Source::Cache, 1));
}

#[test]
fn an_edited_photo_is_developed_and_never_shows_the_camera_preview() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    write_sidecar(&photo, |document| document.model.exposure = 1.0);
    let renders = Renders::with_camera_preview();

    let (_, source) = produce_with(&renders, &photo).unwrap();

    assert_eq!(source, Source::Developed);
    assert_eq!((renders.count(), renders.extractions()), (1, 0));
}

#[test]
fn a_photo_without_a_camera_preview_is_developed() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();

    let (image, source) = produce_with(&renders, &photo).unwrap();

    assert_eq!(source, Source::Developed);
    assert_eq!((renders.count(), renders.extractions()), (1, 1));
    assert_eq!(image.width(), disk::LONG_EDGE_PX);
}

#[test]
fn a_sidecar_holding_only_a_rating_leaves_the_photo_unedited() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    write_sidecar(&photo, |document| document.culling.rating = 4);
    let renders = Renders::with_camera_preview();

    let (_, source) = produce_with(&renders, &photo).unwrap();

    assert_eq!(source, Source::CameraPreview);
    assert_eq!(renders.count(), 0);
}

#[test]
fn a_raster_photo_is_never_given_a_camera_preview() {
    let folder = tempfile::tempdir().unwrap();
    let photo = Photo {
        kind: crate::library::MediaKind::Raster,
        ..photo_in(folder.path(), "IMG_0001.JPG")
    };
    let renders = Renders::with_camera_preview();

    let (_, source) = produce_with(&renders, &photo).unwrap();

    assert_eq!(source, Source::Developed);
    assert_eq!(renders.extractions(), 0);
}

#[test]
fn a_damaged_sidecar_is_an_error_and_publishes_nothing() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    fs::write(folder.path().join("IMG_0001.xmp"), "this is not xml").unwrap();
    let renders = Renders::with_camera_preview();

    assert!(produce_with(&renders, &photo).is_err());

    assert_eq!((renders.count(), renders.extractions()), (0, 0));
    assert!(!folder.path().join(".maple").exists());
}

fn produced_while(
    photo: &Photo,
    renders: &Renders,
    during_render: impl Fn(&Photo),
) -> Result<(RgbImage, Source), String> {
    produce(
        photo,
        &|photo, edge| {
            during_render(photo);
            renders.develop(photo, edge)
        },
        &|_, _| None,
        &disk::encode,
    )
}

fn produced_encoding_with(
    photo: &Photo,
    renders: &Renders,
    after_encode: impl Fn(&Photo),
) -> Result<(RgbImage, Source), String> {
    produce(
        photo,
        &|photo, edge| renders.develop(photo, edge),
        &|_, _| None,
        &|image| {
            let bytes = disk::encode(image);
            after_encode(photo);
            bytes
        },
    )
}

#[test]
fn a_tile_rendered_from_a_sidecar_saved_mid_render_is_shown_but_never_published() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();

    let (_, source) = produced_while(&photo, &renders, |photo| {
        write_sidecar(photo, |document| document.model.exposure = 1.0)
    })
    .unwrap();

    assert_eq!((source, renders.count()), (Source::Developed, 1));
    assert!(!folder.path().join(".maple").exists());
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
    assert!(folder
        .path()
        .join(".maple/thumbs/IMG_0001.CR2.avif")
        .exists());
}

#[test]
fn a_tile_rendered_from_an_original_replaced_mid_render_is_never_published() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();

    produced_while(&photo, &renders, |photo| {
        fs::write(
            &photo.path,
            b"a different, longer original than the one rendered",
        )
        .unwrap()
    })
    .unwrap();

    assert!(!folder.path().join(".maple").exists());
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
}

#[test]
fn a_tile_whose_sidecar_is_saved_while_it_is_encoded_is_shown_but_never_published() {
    let folder = tempfile::tempdir().unwrap();
    let photo = photo_in(folder.path(), "IMG_0001.CR2");
    let renders = Renders::new();

    let (_, source) = produced_encoding_with(&photo, &renders, |photo| {
        write_sidecar(photo, |document| document.model.exposure = 1.0)
    })
    .unwrap();

    assert_eq!((source, renders.count()), (Source::Developed, 1));
    assert!(!folder
        .path()
        .join(".maple/thumbs/IMG_0001.CR2.avif")
        .exists());
    let (_, source) = produce_with(&renders, &photo).unwrap();
    assert_eq!((source, renders.count()), (Source::Developed, 2));
}
