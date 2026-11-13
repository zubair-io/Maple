//! One-level folder discovery for local sources. No recursive eager scan.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Raw,
    Raster,
}

#[derive(Clone, Debug)]
pub struct Photo {
    pub path: PathBuf,
    pub kind: MediaKind,
    pub modified: SystemTime,
    pub size: u64,
}

#[derive(Debug)]
pub struct Folder {
    pub path: PathBuf,
    pub folders: Vec<PathBuf>,
    pub photos: Vec<Photo>,
    /// Per-entry failures never hide the successfully discovered assets.
    pub errors: Vec<String>,
}

impl Folder {
    pub fn scan(path: &Path) -> Result<Self, std::io::Error> {
        let mut folder = Self {
            path: path.to_path_buf(),
            folders: Vec::new(),
            photos: Vec::new(),
            errors: Vec::new(),
        };
        for entry in fs::read_dir(path)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    folder.errors.push(error.to_string());
                    continue;
                }
            };
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    folder.errors.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            if metadata.is_dir() {
                folder.folders.push(path);
            } else if metadata.is_file() {
                if let Some(kind) = media_kind(&path) {
                    let modified = match metadata.modified() {
                        Ok(modified) => modified,
                        Err(error) => {
                            folder.errors.push(format!("{}: {error}", path.display()));
                            continue;
                        }
                    };
                    folder.photos.push(Photo {
                        path,
                        kind,
                        modified,
                        size: metadata.len(),
                    });
                }
            }
        }
        folder
            .folders
            .sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));
        folder
            .photos
            .sort_by(|a, b| a.path.file_name().cmp(&b.path.file_name()));
        Ok(folder)
    }
}

pub struct FileFormat {
    pub extension: &'static str,
    pub mime_type: &'static str,
    pub kind: MediaKind,
    /// Set when shared-mime-info 2.4 (Ubuntu 24.04) lacks the type, so Maple's
    /// own MIME package must declare it for file-manager associations.
    pub declared_comment: Option<&'static str>,
}

const fn format(extension: &'static str, mime_type: &'static str, kind: MediaKind) -> FileFormat {
    FileFormat {
        extension,
        mime_type,
        kind,
        declared_comment: None,
    }
}

const fn declared(
    extension: &'static str,
    mime_type: &'static str,
    comment: &'static str,
) -> FileFormat {
    FileFormat {
        extension,
        mime_type,
        kind: MediaKind::Raw,
        declared_comment: Some(comment),
    }
}

pub const FILE_FORMATS: &[FileFormat] = &[
    format("cr2", "image/x-canon-cr2", MediaKind::Raw),
    format("cr3", "image/x-canon-cr3", MediaKind::Raw),
    format("nef", "image/x-nikon-nef", MediaKind::Raw),
    format("arw", "image/x-sony-arw", MediaKind::Raw),
    format("dng", "image/x-adobe-dng", MediaKind::Raw),
    format("raf", "image/x-fuji-raf", MediaKind::Raw),
    format("orf", "image/x-olympus-orf", MediaKind::Raw),
    format("rw2", "image/x-panasonic-rw2", MediaKind::Raw),
    format("pef", "image/x-pentax-pef", MediaKind::Raw),
    declared("srw", "image/x-samsung-srw", "Samsung SRW raw image"),
    format("x3f", "image/x-sigma-x3f", MediaKind::Raw),
    declared("3fr", "image/x-hasselblad-3fr", "Hasselblad 3FR raw image"),
    declared("mef", "image/x-mamiya-mef", "Mamiya MEF raw image"),
    declared("erf", "image/x-epson-erf", "Epson ERF raw image"),
    format("mrw", "image/x-minolta-mrw", MediaKind::Raw),
    format("raw", "image/x-panasonic-rw", MediaKind::Raw),
    declared("fff", "image/x-hasselblad-fff", "Hasselblad FFF raw image"),
    format("jpg", "image/jpeg", MediaKind::Raster),
    format("jpeg", "image/jpeg", MediaKind::Raster),
    format("png", "image/png", MediaKind::Raster),
    format("webp", "image/webp", MediaKind::Raster),
    format("tif", "image/tiff", MediaKind::Raster),
    format("tiff", "image/tiff", MediaKind::Raster),
];

pub fn media_kind(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    FILE_FORMATS
        .iter()
        .find(|format| format.extension == extension)
        .map(|format| format.kind)
}
