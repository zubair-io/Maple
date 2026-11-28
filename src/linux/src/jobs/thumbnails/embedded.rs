//! The camera's own preview of an unedited RAW, read by seeking to it, as the Apple and Windows thumbnailer does.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    num::NonZeroUsize,
};

use image::RgbImage;
use rawler::rawsource::RawSource;

use crate::{
    library::Photo,
    sidecar::{SidecarError, SidecarStore},
};

/// A sidecar that is empty or holds only metadata (rating, label, keywords) is unedited, as on the server and Android.
pub(super) fn is_edited(photo: &Photo) -> Result<bool, SidecarError> {
    SidecarStore::open(&photo.path).map(|(_, document)| document.model.has_render_adjustments())
}

/// A JPEG or TIFF is decoded from every byte and an X3F preview is found by scanning the container.
fn reads_whole_file(extension: &str) -> bool {
    ["jpg", "jpeg", "tif", "tiff", "x3f"]
        .iter()
        .any(|whole| extension.eq_ignore_ascii_case(whole))
}

/// `None` when the file has no preview the extractor can read, so the caller develops the RAW instead.
pub(super) fn camera_preview(photo: &Photo, long_edge: u32) -> Option<RgbImage> {
    let extension = photo.path.extension()?.to_str()?;
    preview_from(File::open(&photo.path).ok()?, extension, long_edge)
}

fn preview_from<R: Read + Seek + Send>(
    mut reader: R,
    extension: &str,
    long_edge: u32,
) -> Option<RgbImage> {
    let length = reader
        .seek(SeekFrom::End(0))
        .ok()
        .and_then(|length| usize::try_from(length).ok())
        .and_then(NonZeroUsize::new);
    match length.filter(|_| !reads_whole_file(extension)) {
        Some(length) => {
            let paged = raw_core::paged_file::PagedFile::new(reader, length);
            oriented(RawSource::new_lazy(&paged), extension, long_edge)
        }
        None => {
            reader.rewind().ok()?;
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).ok()?;
            oriented(
                RawSource::new_from_borrowed_slice(&bytes),
                extension,
                long_edge,
            )
        }
    }
}

fn oriented(source: RawSource<'_>, extension: &str, long_edge: u32) -> Option<RgbImage> {
    let (preview, orientation) =
        raw_core::preview::extract_embedded_preview_from(source, extension).ok()?;
    let resized = raw_core::preview::resize_long_edge(preview, long_edge).to_rgb8();
    let (width, height, pixels) = raw_core::image::apply_orientation(
        resized.as_raw(),
        resized.width(),
        resized.height(),
        orientation,
    );
    RgbImage::from_raw(width, height, pixels)
}

#[cfg(test)]
#[path = "embedded_tests.rs"]
mod embedded_tests;
