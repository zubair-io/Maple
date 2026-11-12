//! Non-destructive Linux sidecar documents and persistence (#4317).
//! Imported XML is retained; only this shell's owned scalar attributes change.
//! Outside changes are merged by the shared `reconcile_xmp` (#4983).

mod xml;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use raw_core::types::adjustment::AdjustmentModel;
use raw_core::workflow::SidecarWorkflow;
use tempfile::NamedTempFile;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("{0}")]
    Invalid(String),
    #[error("The sidecar changed outside Maple while saving. Save again to merge the change.")]
    Conflict,
    #[error("The sidecar was removed outside Maple. Reload XMP before saving.")]
    Removed,
    #[error(
        "The sidecar changed outside Maple and could not be merged: {0}. Reload XMP before saving."
    )]
    Merge(String),
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
    /// The sidecar revision this document's edits are relative to.
    base: Option<String>,
}

impl SidecarDocument {
    pub fn parse(source: &str) -> Result<Self, SidecarError> {
        let (model, culling) = xml::parse(source)?;
        Ok(Self {
            model,
            culling,
            source: Some(source.to_owned()),
            base: Some(source.to_owned()),
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

/// Saves are compare-and-swap against the revision a document was based on.
/// Callers serialize saves on their I/O worker, outside the UI/render thread.
pub struct SidecarStore {
    path: PathBuf,
    /// Document base → the revision its next edit is merged against. Maple's
    /// own publications advance it, so queued documents are not outside changes.
    lineages: Vec<(Option<String>, Option<String>)>,
}

impl SidecarStore {
    pub fn open(original: &Path) -> Result<(Self, SidecarDocument), SidecarError> {
        let path = sidecar_path(original)?;
        reject_symlink(&path)?;
        let document = match read_optional(&path)? {
            Some(source) => SidecarDocument::parse(&source)?,
            None => SidecarDocument::default(),
        };
        Ok((
            Self {
                path,
                lineages: Vec::new(),
            },
            document,
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `Ok(Some)` carries the published document when an outside change was
    /// merged into it, for the editor to adopt.
    pub fn save(&mut self, document: &SidecarDocument) -> Result<Option<Merged>, SidecarError> {
        let incoming = document.serialize()?;
        reject_symlink(&self.path)?;
        let base = self
            .lineages
            .iter()
            .find(|(from, _)| *from == document.base)
            .map_or_else(|| document.base.clone(), |(_, to)| to.clone());
        let current = read_optional(&self.path)?;
        let merged = if current == base {
            None
        } else {
            let current = current.as_deref().ok_or(SidecarError::Removed)?;
            Some(Merged::reconcile(base.as_deref(), current, &incoming)?)
        };
        let bytes = merged
            .as_ref()
            .and_then(|merged| merged.document.base.clone())
            .unwrap_or_else(|| incoming.clone());
        // This lineage's later documents (queued saves, undo states) hold values
        // relative to what Maple meant to publish, so that is their next base:
        // after a merge, only their own changes apply on top of the outside one.
        self.publish(&bytes, current.as_deref(), |store| {
            store.advance(document.base.clone(), Some(incoming))
        })?;
        Ok(merged)
    }

    fn advance(&mut self, from: Option<String>, to: Option<String>) {
        match self.lineages.iter_mut().find(|(base, _)| *base == from) {
            Some(lineage) => lineage.1 = to,
            None => self.lineages.push((from, to)),
        }
    }

    fn publish(
        &mut self,
        bytes: &str,
        expected: Option<&str>,
        published: impl FnOnce(&mut Self),
    ) -> Result<(), SidecarError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| SidecarError::Invalid("Sidecar has no parent".into()))?
            .to_path_buf();
        let mut temporary = shared_temp_file(&parent)?;
        if let Ok(metadata) = fs::metadata(&self.path) {
            temporary
                .as_file()
                .set_permissions(metadata.permissions())?;
        }
        temporary.write_all(bytes.as_bytes())?;
        temporary.as_file().sync_all()?;
        // Re-check after merge/write, immediately before atomic rename.
        reject_symlink(&self.path)?;
        if read_optional(&self.path)?.as_deref() != expected {
            return Err(SidecarError::Conflict);
        }
        temporary.persist(&self.path).map_err(|error| error.error)?;
        // Record the publication even if directory durability fails: the
        // next retry must compare against the bytes actually on disk.
        published(self);
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

/// A save that merged an outside change: `document` is what was published.
#[derive(Clone, Debug)]
pub struct Merged {
    pub document: SidecarDocument,
    /// The revision the merged edit was based on, and what the file held.
    base: Option<String>,
    outside: String,
    now_ms: u64,
}

impl Merged {
    fn reconcile(base: Option<&str>, current: &str, incoming: &str) -> Result<Self, SidecarError> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        Ok(Self {
            document: reconcile(base, current, incoming, now_ms)?,
            base: base.map(str::to_owned),
            outside: current.to_owned(),
            now_ms,
        })
    }

    /// Another state of the same edit (an undo or redo snapshot) with the
    /// outside change applied, in the published document's lineage: restoring
    /// it neither reverts that change nor, as an adopted snapshot would be,
    /// is mistaken for an unchanged outside document that cancels Maple's own
    /// later change (#5887).
    pub fn rebase(&self, snapshot: &SidecarDocument) -> Result<SidecarDocument, SidecarError> {
        let incoming = snapshot.serialize()?;
        let mut rebased = reconcile(self.base.as_deref(), &self.outside, &incoming, self.now_ms)?;
        rebased.base = self.document.base.clone();
        Ok(rebased)
    }
}

/// The shared #4983 three-way merge. The result is re-saved through this
/// writer so the adopted document re-serializes to the published bytes.
fn reconcile(
    base: Option<&str>,
    current: &str,
    incoming: &str,
    now_ms: u64,
) -> Result<SidecarDocument, SidecarError> {
    let merge_error = |error: SidecarError| SidecarError::Merge(error.to_string());
    for document in [current, incoming] {
        // The shared merge edits only the primary Description.
        if xml::description_count(document).map_err(merge_error)? != 1 {
            return Err(SidecarError::Merge(
                "it does not hold exactly one rdf:Description".into(),
            ));
        }
    }
    // Compare Maple's edit with what this writer makes of the unedited base,
    // so its own normalization (dropped defaults, number format) is not
    // mistaken for an edit that overrides the outside change.
    let base = base
        .map(|base| SidecarDocument::parse(base).and_then(|document| document.serialize()))
        .transpose()
        .map_err(merge_error)?;
    let merged = SidecarWorkflow::reconcile_xmp(
        base.as_deref().unwrap_or_default(),
        current,
        incoming,
        now_ms,
    )
    .map_err(SidecarError::Merge)?;
    let normalized = SidecarDocument::parse(&merged)
        .and_then(|document| document.serialize())
        .map_err(merge_error)?;
    SidecarDocument::parse(&normalized)
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

/// Sidecars and exports are read by other processes (the Self Hosted API,
/// network shares), so a new file gets the umask default rather than the
/// owner-only mode temp files are created with.
pub(crate) fn shared_temp_file(parent: &Path) -> std::io::Result<NamedTempFile> {
    use std::os::unix::fs::PermissionsExt;
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o666))
        .tempfile_in(parent)
}
