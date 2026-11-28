//! The shared on-share thumbnail tier, `<folder>/.maple/thumbs/<filename.ext>.avif` (docs/caching.md § The on-share write contract).
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use image::RgbImage;

pub(super) const LONG_EDGE_PX: u32 = 512;
const AVIF_QUALITY: u8 = 55;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

pub(super) fn entry_path(original: &Path) -> Option<PathBuf> {
    let mut name = original.file_name()?.to_os_string();
    name.push(".avif");
    Some(original.parent()?.join(".maple").join("thumbs").join(name))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    modified: SystemTime,
    len: u64,
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let metadata = fs::metadata(path).ok()?;
        Some(Self {
            modified: metadata.modified().ok()?,
            len: metadata.len(),
        })
    }
}

/// The original's and the sidecar's state when a tile was started; an entry built from inputs that
/// have since changed must not be published, because its newer publication time would make it look fresh.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Inputs {
    original: Option<Stamp>,
    sidecar: Option<Stamp>,
}

impl Inputs {
    pub(super) fn of(original: &Path) -> Self {
        Self {
            original: Stamp::of(original),
            sidecar: crate::sidecar::sidecar_path(original)
                .ok()
                .and_then(|path| Stamp::of(&path)),
        }
    }

    fn predate(&self, entry: SystemTime) -> bool {
        self.original.is_some_and(|stamp| stamp.modified <= entry)
            && self.sidecar.is_none_or(|stamp| stamp.modified <= entry)
    }
}

pub(super) fn read_fresh(original: &Path, inputs: Inputs) -> Option<RgbImage> {
    let entry = entry_path(original)?;
    let metadata = fs::symlink_metadata(&entry).ok()?;
    if !metadata.is_file()
        || metadata.len() > MAX_ENTRY_BYTES
        || !inputs.predate(metadata.modified().ok()?)
    {
        return None;
    }
    let decoded = raw_core::raster::decode_raster(&fs::read(&entry).ok()?, Some("avif")).ok()?;
    RgbImage::from_raw(decoded.width, decoded.height, decoded.to_rgb_bytes())
}

pub(super) type Encode<'a> = &'a dyn Fn(&RgbImage) -> io::Result<Vec<u8>>;

pub(super) fn encode(image: &RgbImage) -> io::Result<Vec<u8>> {
    raw_core::avif::encode(image.width(), image.height(), image.as_raw(), AVIF_QUALITY)
        .map_err(io::Error::other)
}

pub(super) fn write(original: &Path, built_from: Inputs, image: &RgbImage, encode: Encode) {
    let _ = publish(original, built_from, image, encode);
}

fn publish(
    original: &Path,
    built_from: Inputs,
    image: &RgbImage,
    encode: Encode,
) -> io::Result<()> {
    let entry = entry_path(original).ok_or(io::ErrorKind::InvalidInput)?;
    let thumbs = entry.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let bytes = encode(image)?;
    // Checked after the slow encode: an edit saved during it must not leave a stale entry stamped newer than the sidecar.
    if Inputs::of(original) != built_from {
        return Ok(());
    }
    plain_directory(thumbs.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    plain_directory(thumbs)?;
    raw_core::output_file::write_derived(&entry, &[original], &bytes)
}

/// A symlinked cache folder would send the write wherever the folder's owner pointed it.
fn plain_directory(path: &Path) -> io::Result<()> {
    let checked = || match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the thumbnail folder is not a plain directory",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    };
    if checked()? {
        return Ok(());
    }
    match fs::create_dir(path) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => checked().map(drop),
    }
}
