//! Non-destructive Linux sidecar documents and persistence (#4317).
//! Imported XML is retained; only this shell's owned scalar attributes change.

mod xml;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use raw_core::types::adjustment::AdjustmentModel;
use tempfile::NamedTempFile;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("{0}")]
    Invalid(String),
    #[error("The sidecar changed outside Maple. Reload it before saving.")]
    Conflict,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Flag {
    #[default]
    Unflagged,
    Pick,
    Reject,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Culling {
    pub rating: u8,
    pub flag: Flag,
}

#[derive(Clone, Debug, Default)]
pub struct SidecarDocument {
    pub model: AdjustmentModel,
    pub culling: Culling,
    source: Option<String>,
}

impl SidecarDocument {
    pub fn parse(source: &str) -> Result<Self, SidecarError> {
        let (model, culling) = xml::parse(source)?;
        Ok(Self {
            model,
            culling,
            source: Some(source.to_owned()),
        })
    }

    /// Reset known develop controls, retaining crop, rotation, culling and unknown XML.
    pub fn reset_develop(&mut self) -> Result<(), SidecarError> {
        let current = self.serialize()?;
        let cleared = xml::reset(&current)?;
        let (model, _) = xml::parse(&cleared)?;
        self.model = model;
        self.source = Some(cleared);
        Ok(())
    }

    pub fn serialize(&self) -> Result<String, SidecarError> {
        xml::serialize(self.source.as_deref(), &self.model, &self.culling)
    }
}

/// A loaded document's immutable baseline is the optimistic save token.
/// Callers serialize saves on their I/O worker, outside the UI/render thread.
pub struct SidecarStore {
    path: PathBuf,
    baseline: Option<String>,
}

impl SidecarStore {
    pub fn open(original: &Path) -> Result<(Self, SidecarDocument), SidecarError> {
        let path = sidecar_path(original)?;
        reject_symlink(&path)?;
        let baseline = read_optional(&path)?;
        let document = match &baseline {
            Some(source) => SidecarDocument::parse(source)?,
            None => SidecarDocument::default(),
        };
        Ok((Self { path, baseline }, document))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&mut self, document: &SidecarDocument) -> Result<(), SidecarError> {
        let bytes = document.serialize()?;
        reject_symlink(&self.path)?;
        if read_optional(&self.path)? != self.baseline {
            return Err(SidecarError::Conflict);
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| SidecarError::Invalid("Sidecar has no parent".into()))?;
        let mut temporary = NamedTempFile::new_in(parent)?;
        if let Ok(metadata) = fs::metadata(&self.path) {
            temporary
                .as_file()
                .set_permissions(metadata.permissions())?;
        }
        temporary.write_all(bytes.as_bytes())?;
        temporary.as_file().sync_all()?;
        // Re-check after serialization/write, immediately before atomic rename.
        reject_symlink(&self.path)?;
        if read_optional(&self.path)? != self.baseline {
            return Err(SidecarError::Conflict);
        }
        temporary.persist(&self.path).map_err(|error| error.error)?;
        // Publish the new token after rename even if directory durability fails:
        // the next retry must compare against the bytes actually on disk.
        self.baseline = Some(bytes);
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

pub fn sidecar_path(original: &Path) -> Result<PathBuf, SidecarError> {
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension.is_empty() || extension == "xmp" {
        return Err(SidecarError::Invalid(
            "Select an image or video, not an XMP sidecar".into(),
        ));
    }
    let video = matches!(
        extension.as_str(),
        "mov"
            | "mp4"
            | "m4v"
            | "avi"
            | "mkv"
            | "mts"
            | "m2ts"
            | "webm"
            | "3gp"
            | "mxf"
            | "3g2"
            | "flv"
            | "vob"
            | "mpg"
            | "wmv"
            | "f4v"
    );
    Ok(if video {
        let mut name = original.as_os_str().to_os_string();
        name.push(".xmp");
        PathBuf::from(name)
    } else {
        original.with_extension("xmp")
    })
}

fn read_optional(path: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::read_to_string(path) {
        Ok(source) => Ok(Some(source)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn reject_symlink(path: &Path) -> Result<(), SidecarError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(SidecarError::Invalid(
            "Refusing to save through a sidecar symlink".into(),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
