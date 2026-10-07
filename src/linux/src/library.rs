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

pub fn media_kind(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "cr2" | "cr3" | "nef" | "arw" | "dng" | "raf" | "orf" | "rw2" | "pef" | "srw" | "x3f"
        | "3fr" | "mef" | "erf" | "mrw" | "raw" | "fff" => Some(MediaKind::Raw),
        "jpg" | "jpeg" | "png" | "webp" | "tif" | "tiff" => Some(MediaKind::Raster),
        _ => None,
    }
}
